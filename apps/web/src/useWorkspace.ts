import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  createEventStream,
  normalizeAskUserQuestion,
  normalizeAssistantBlock,
  normalizeAttachment,
  normalizeConversation,
  normalizeMemoryReference,
  normalizeMessage,
  type ResearchStudyConfig
} from "./api";
import { isThinkingBlock } from "./responseStatus";
import { consumerSendError } from "./consumerErrors";
import { t, useLocale } from "./i18n";
import { applyRunEventState, settleRunMessages } from "./runState";
import type {
  LearningCondition,
  AgentEvent,
  AgentProfileId,
  AgentProfileSummary,
  AssistantBlockDto,
  Attachment,
  Capabilities,
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  Participant,
  SendMode,
  ToastMessage
} from "./types";

const BACKEND_RETRY_MS = 5000;
const fallbackProfiles: AgentProfileSummary[] = [
  { id: "graduate-admissions", name: "申学助手", description: "规划项目、材料与关键时间点" },
  { id: "local-operator", name: "本地执行助手", description: "处理文件、研究与日常任务" }
];

function sortConversations(items: ConversationSummary[]) {
  return [...items].sort(
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
}

function updateAssistantBlock(
  blocks: AssistantBlockDto[],
  id: string,
  update: (block: AssistantBlockDto) => AssistantBlockDto
): AssistantBlockDto[] {
  return blocks.map((block) =>
    block.id === id ? update(block) : { ...block, children: updateAssistantBlock(block.children, id, update) }
  );
}

function hasAssistantBlock(blocks: AssistantBlockDto[], id: string): boolean {
  return blocks.some((block) => block.id === id || hasAssistantBlock(block.children, id));
}

function completeOpenThinkingBlocks(blocks: AssistantBlockDto[]): AssistantBlockDto[] {
  return blocks.map((block) => ({
    ...block,
    ...(isThinkingBlock(block) && (block.status === "running" || block.status === "queued")
      ? { status: "completed" as const }
      : {}),
    children: completeOpenThinkingBlocks(block.children)
  }));
}

function insertAssistantBlock(blocks: AssistantBlockDto[], block: AssistantBlockDto): AssistantBlockDto[] {
  if (blocks.some((item) => item.id === block.id)) return blocks;
  if (!block.parentId) return [...blocks, block];
  const insertNested = (items: AssistantBlockDto[]): [AssistantBlockDto[], boolean] => {
    let found = false;
    const next = items.map((item) => {
      if (item.id === block.parentId) {
        found = true;
        return { ...item, children: [...item.children, block] };
      }
      const [children, childFound] = insertNested(item.children);
      if (childFound) found = true;
      return childFound ? { ...item, children } : item;
    });
    return [next, found];
  };
  const [next, inserted] = insertNested(blocks);
  return inserted ? next : [...blocks, block];
}

export function mergeActivityBlock(
  current: AssistantBlockDto,
  incoming: AssistantBlockDto,
  eventType: string,
  eventCreatedAt?: string
): AssistantBlockDto {
  const terminal = eventType === "activity.completed" || eventType === "activity.failed";
  return {
    ...current,
    ...incoming,
    startedAt: incoming.startedAt ?? current.startedAt,
    completedAt: incoming.completedAt ?? (terminal ? (eventCreatedAt ?? current.completedAt) : current.completedAt),
    children: incoming.children.length ? incoming.children : current.children
  };
}

export function useWorkspace() {
  useLocale();
  const [capabilities, setCapabilities] = useState<Capabilities>({
    attachments: { enabled: true, maxFiles: 8, maxBytes: 30 * 1024 * 1024 },
    reasoningSummary: true,
    tools: true
  });
  const [active, setActive] = useState<ConversationSummary[]>([]);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileSummary[]>(fallbackProfiles);
  const [researchEnabled, setResearchEnabled] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [participantId, setParticipantId] = useState("default");
  const [researchStudy, setResearchStudy] = useState<ResearchStudyConfig | null>(null);
  const [archived, setArchived] = useState<ConversationSummary[]>([]);
  const [details, setDetails] = useState<Record<string, ConversationDetail>>({});
  const [selectedId, setSelectedIdState] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("conversation") ?? undefined
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [backendDown, setBackendDown] = useState(false);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [streamRevision, setStreamRevision] = useState(0);
  const cursors = useRef<Record<string, string>>({});
  const seenEvents = useRef<Record<string, Set<string>>>({});
  const drafts = useRef<Record<string, ConversationSummary>>({});

  // The server is reachable but runs the scripted runtime. Everything still goes
  // through the real API; only the model behind it is a stand-in.
  const demoMode = capabilities.runtime === "demo";

  const toast = useCallback(
    (message: string, tone: ToastMessage["tone"] = "default", action?: ToastMessage["action"]) => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { id, message, tone, action }]);
      window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), action ? 8000 : 4200);
    },
    []
  );

  const dismissToast = useCallback(
    (id: string) => setToasts((current) => current.filter((item) => item.id !== id)),
    []
  );

  const refreshCapabilities = useCallback(async () => {
    const next = await api.capabilities();
    setCapabilities(next);
    setBackendDown(false);
    return next;
  }, []);

  const loadLists = useCallback(async (query = "", options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      const [caps, activeItems, archivedItems, participantState] = await Promise.all([
        api.capabilities(),
        api.conversations("active", query),
        api.conversations("archived", query),
        // Re-sync the switcher on every list load so a second tab cannot keep showing one
        // participant's name over another participant's threads.
        api.participants().catch(() => null)
      ]);
      setCapabilities(caps);
      setActive(sortConversations(activeItems));
      setArchived(sortConversations(archivedItems));
      if (participantState) {
        setParticipants(participantState.participants);
        setParticipantId(participantState.currentId);
      }
      setBackendDown(false);
      setSelectedIdState((current) => current ?? activeItems[0]?.id);
    } catch {
      setBackendDown(true);
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    void api
      .researchSettings()
      .then((settings) => {
        setResearchEnabled(settings.enabled);
        setResearchStudy(settings.study ?? null);
      })
      .catch(() => {});
    void api
      .participants()
      .then((response) => {
        setParticipants(response.participants);
        setParticipantId(response.currentId);
      })
      .catch(() => {});
  }, []);

  // Switching people swaps the whole visible workspace: the conversation list is scoped
  // server-side to the current participant, so the stale selection must not survive.
  const switchParticipant = useCallback(
    async (id: string) => {
      try {
        await api.selectParticipant(id);
        setParticipantId(id);
        setSelectedIdState(undefined);
        await loadLists();
      } catch {
        toast(t("participantSwitchFailed"), "danger");
      }
    },
    [loadLists, toast]
  );

  const addParticipant = useCallback(
    async (displayName: string) => {
      try {
        const response = await api.createParticipant(displayName);
        setParticipants((current) => [...current, response.participant]);
        await switchParticipant(response.participant.id);
      } catch {
        toast(t("participantCreateFailed"), "danger");
      }
    },
    [switchParticipant, toast]
  );

  // While the local server is unreachable the workspace polls quietly; a successful
  // load clears `backendDown` and repopulates the lists in the same pass.
  useEffect(() => {
    if (!backendDown) return;
    const timer = window.setInterval(() => {
      void loadLists("", { silent: true });
    }, BACKEND_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [backendDown, loadLists]);

  useEffect(() => {
    void api
      .agentProfiles()
      .then((items) => {
        if (items.length) setAgentProfiles(items);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("conversation", selectedId);
    else url.searchParams.delete("conversation");
    window.history.replaceState(null, "", url);
  }, [selectedId]);

  useEffect(() => {
    if (backendDown) return;
    const timer = window.setTimeout(() => {
      void Promise.all([api.conversations("active", searchQuery), api.conversations("archived", searchQuery)])
        .then(([a, b]) => {
          setActive(sortConversations(a));
          setArchived(sortConversations(b));
        })
        .catch(() => toast(t("searchUnavailable")));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchQuery, backendDown, toast]);

  useEffect(() => {
    if (!selectedId || details[selectedId] || selectedId.startsWith("local-")) return;
    void api
      .conversation(selectedId)
      .then((detail) => setDetails((current) => ({ ...current, [selectedId]: detail })))
      .catch(() => {
        toast(t("cannotLoadChat"), "danger");
        setSelectedIdState(active[0]?.id);
      });
  }, [selectedId, details, toast, active]);

  const applyEvent = useCallback(
    (conversationId: string, event: AgentEvent) => {
      const seen = seenEvents.current[conversationId] ?? new Set<string>();
      if (seen.has(event.id)) return;
      seen.add(event.id);
      seenEvents.current[conversationId] = seen;
      if (event.cursor) cursors.current[conversationId] = event.cursor;
      const conversationUpdate =
        event.type === "conversation.updated" && event.data?.conversation
          ? normalizeConversation(event.data.conversation)
          : undefined;
      if (conversationUpdate) {
        setActive((items) =>
          sortConversations(
            items.map((item) => (item.id === conversationId ? { ...item, ...conversationUpdate } : item))
          )
        );
        setArchived((items) =>
          sortConversations(
            items.map((item) => (item.id === conversationId ? { ...item, ...conversationUpdate } : item))
          )
        );
      }
      if (event.type === "memory.changed" && event.data?.automatic !== true) {
        const mutationId = typeof event.data?.mutationId === "string" ? event.data.mutationId : undefined;
        const message = typeof event.data?.message === "string" ? event.data.message : t("memoryUpdated");
        toast(
          message,
          "success",
          mutationId
            ? {
                label: t("undo"),
                onClick: () =>
                  void api
                    .undoMemoryMutation(mutationId)
                    .then(() => toast(t("memoryUndone"), "success"))
                    .catch(() => toast(t("cannotUndo"), "danger"))
              }
            : undefined
        );
      }
      if (event.type.startsWith("learning.")) {
        void api
          .learningSession(conversationId)
          .then((learningSession) => {
            setDetails((current) =>
              current[conversationId]
                ? { ...current, [conversationId]: { ...current[conversationId], learningSession } }
                : current
            );
          })
          .catch(() => undefined);
      }

      setDetails((current) => {
        const detail = current[conversationId];
        if (!detail) return current;
        let messages = detail.messages;
        let queuedRuns = detail.queuedRuns ?? [];
        const payloadMessage = event.data?.message;
        if (event.type === "message.created" && payloadMessage) {
          const next = normalizeMessage(payloadMessage);
          if (!messages.some((message) => message.id === next.id)) messages = [...messages, next];
        } else if (event.type.startsWith("activity.")) {
          const payload = (event.data ?? {}) as Record<string, unknown>;
          const blockPayload = (
            payload.block && typeof payload.block === "object"
              ? payload.block
              : payload.activity && typeof payload.activity === "object"
                ? payload.activity
                : payload
          ) as Record<string, unknown>;
          const activityId =
            typeof payload.blockId === "string"
              ? payload.blockId
              : typeof payload.block_id === "string"
                ? payload.block_id
                : typeof blockPayload.id === "string"
                  ? blockPayload.id
                  : typeof blockPayload.activityId === "string"
                    ? blockPayload.activityId
                    : typeof blockPayload.activity_id === "string"
                      ? blockPayload.activity_id
                      : (event.toolUseId ?? event.id);
          const targetMessageId =
            typeof payload.messageId === "string"
              ? payload.messageId
              : typeof payload.message_id === "string"
                ? payload.message_id
                : event.messageId;
          const fallbackMessageId = [...messages].reverse().find((item) => item.role === "assistant")?.id;
          messages = messages.map((message) => {
            const isTarget =
              message.role === "assistant" &&
              (targetMessageId
                ? message.id === targetMessageId
                : event.runId
                  ? message.runId === event.runId
                  : message.id === fallbackMessageId);
            if (!isTarget) return message;
            let blocks =
              event.type === "activity.started"
                ? completeOpenThinkingBlocks(message.blocks ?? [])
                : (message.blocks ?? []);
            if (event.type === "activity.text.delta") {
              if (!hasAssistantBlock(blocks, activityId))
                blocks = insertAssistantBlock(
                  blocks,
                  normalizeAssistantBlock({
                    id: activityId,
                    messageId: targetMessageId,
                    runId: event.runId,
                    kind: "text",
                    status: "running",
                    content: ""
                  })
                );
              const delta = event.content ?? String(payload.delta ?? payload.text ?? "");
              return {
                ...message,
                blocks: updateAssistantBlock(blocks, activityId, (block) => ({
                  ...block,
                  text: `${block.text ?? ""}${delta}`,
                  content: `${block.content ?? ""}${delta}`
                }))
              };
            }
            const legacyStatus =
              event.type === "activity.failed"
                ? "failed"
                : event.type === "activity.completed"
                  ? "completed"
                  : event.type === "activity.started"
                    ? "running"
                    : undefined;
            const canonicalActivity = blockPayload.activity && typeof blockPayload.activity === "object";
            const incoming = normalizeAssistantBlock({
              ...blockPayload,
              id: activityId,
              ...(legacyStatus && !canonicalActivity ? { status: legacyStatus } : {}),
              ...(!canonicalActivity && event.type === "activity.started"
                ? { startedAt: blockPayload.startedAt ?? event.createdAt }
                : {})
            });
            if (!hasAssistantBlock(blocks, activityId))
              return { ...message, blocks: insertAssistantBlock(blocks, incoming) };
            return {
              ...message,
              blocks: updateAssistantBlock(blocks, activityId, (block) =>
                mergeActivityBlock(block, incoming, event.type, event.createdAt)
              )
            };
          });
        } else if (event.type === "reasoning.summary.delta") {
          const id =
            event.messageId ??
            [...messages]
              .reverse()
              .find((item) => item.role === "assistant" && (event.runId ? item.runId === event.runId : true))?.id;
          const payload = (event.data ?? {}) as Record<string, unknown>;
          const blockId =
            typeof payload.blockId === "string"
              ? payload.blockId
              : typeof payload.block_id === "string"
                ? payload.block_id
                : typeof event.blockId === "string"
                  ? event.blockId
                  : undefined;
          const delta = event.summary ?? event.content ?? String(payload.delta ?? "");
          if (id && (delta || blockId)) {
            const exists = messages.some((message) => message.id === id);
            messages = exists
              ? messages.map((message) => {
                  if (message.id !== id) return message;
                  let blocks = message.blocks ?? [];
                  if (blockId) {
                    if (!hasAssistantBlock(blocks, blockId)) {
                      blocks = completeOpenThinkingBlocks(blocks);
                      blocks = insertAssistantBlock(
                        blocks,
                        normalizeAssistantBlock({
                          id: blockId,
                          messageId: id,
                          runId: event.runId,
                          kind: "thinking",
                          order: blocks.length,
                          status: "running",
                          content: ""
                        })
                      );
                    }
                    if (delta) {
                      blocks = updateAssistantBlock(blocks, blockId, (block) => ({
                        ...block,
                        text: `${block.text ?? ""}${delta}`,
                        content: `${block.content ?? ""}${delta}`
                      }));
                    }
                  }
                  return {
                    ...message,
                    reasoningSummary: delta ? `${message.reasoningSummary ?? ""}${delta}` : message.reasoningSummary,
                    status: message.status === "completed" ? message.status : "streaming",
                    blocks
                  };
                })
              : [
                  ...messages,
                  {
                    id,
                    role: "assistant",
                    content: "",
                    createdAt: event.createdAt ?? new Date().toISOString(),
                    status: "streaming",
                    reasoningSummary: delta || undefined,
                    runId: event.runId,
                    blocks: blockId
                      ? [
                          normalizeAssistantBlock({
                            id: blockId,
                            messageId: id,
                            runId: event.runId,
                            kind: "thinking",
                            order: 0,
                            status: "running",
                            content: delta
                          })
                        ]
                      : []
                  }
                ];
          }
        } else if (
          event.type === "text.delta" ||
          event.type === "message.delta" ||
          event.type === "message.text.delta"
        ) {
          const id = event.messageId ?? `stream-${event.runId ?? "active"}`;
          const payload = (event.data ?? {}) as Record<string, unknown>;
          const blockId =
            typeof payload.blockId === "string"
              ? payload.blockId
              : typeof payload.block_id === "string"
                ? payload.block_id
                : undefined;
          const delta = event.content ?? "";
          const exists = messages.some((message) => message.id === id);
          messages = exists
            ? messages.map((message) => {
                if (message.id !== id) return message;
                let blocks = completeOpenThinkingBlocks(message.blocks ?? []);
                if (blockId) {
                  if (!hasAssistantBlock(blocks, blockId))
                    blocks = insertAssistantBlock(
                      blocks,
                      normalizeAssistantBlock({
                        id: blockId,
                        messageId: id,
                        runId: event.runId,
                        kind: "text",
                        order: blocks.length,
                        status: "running",
                        content: ""
                      })
                    );
                  blocks = updateAssistantBlock(blocks, blockId, (block) => ({
                    ...block,
                    text: `${block.text ?? ""}${delta}`,
                    content: `${block.content ?? ""}${delta}`
                  }));
                }
                return { ...message, content: message.content + delta, status: "streaming", blocks };
              })
            : [
                ...messages,
                {
                  id,
                  role: "assistant",
                  content: delta,
                  createdAt: event.createdAt ?? new Date().toISOString(),
                  status: "streaming",
                  blocks: blockId
                    ? [
                        normalizeAssistantBlock({
                          id: blockId,
                          messageId: id,
                          runId: event.runId,
                          kind: "text",
                          order: 0,
                          status: "running",
                          content: delta
                        })
                      ]
                    : []
                }
              ];
        } else if (event.type === "attachment.updated") {
          const rawAttachment = event.data?.attachment ?? event.data;
          const attachment =
            rawAttachment && typeof rawAttachment === "object" ? normalizeAttachment(rawAttachment) : undefined;
          const messageId =
            event.messageId ||
            (attachment && typeof (event.data as { messageId?: string } | undefined)?.messageId === "string"
              ? (event.data as { messageId: string }).messageId
              : undefined);
          if (attachment && messageId) {
            messages = messages.map((message) => {
              if (message.id !== messageId) return message;
              const current = message.attachments ?? [];
              return {
                ...message,
                attachments: current.some((item) => item.id === attachment.id)
                  ? current.map((item) => (item.id === attachment.id ? attachment : item))
                  : [...current, attachment]
              };
            });
          }
        } else if (event.type === "message.completed" || event.type === "message.interrupted") {
          const status = event.type.endsWith("interrupted") ? "interrupted" : "completed";
          messages = messages.map((message) => (message.id === event.messageId ? { ...message, status } : message));
        } else if (event.type === "memory.recalled" && Array.isArray(event.data?.references)) {
          const references = event.data.references.map(normalizeMemoryReference);
          messages = messages.map((message) =>
            message.role === "assistant" && message.runId === event.runId
              ? { ...message, memoryReferences: references }
              : message
          );
        } else if (event.type === "message.updated") {
          const messageId =
            event.messageId || (typeof event.data?.messageId === "string" ? event.data.messageId : undefined);
          const content = event.content ?? (typeof event.data?.content === "string" ? event.data.content : undefined);
          if (messageId && content !== undefined) {
            messages = messages.map((message) => (message.id === messageId ? { ...message, content } : message));
          }
        }
        if (event.runId && event.type === "run.interrupted" && event.data?.reason === "queued_run_deleted") {
          messages = messages.filter((message) => message.runId !== event.runId);
          queuedRuns = queuedRuns.filter((run) => run.runId !== event.runId);
        } else if (
          event.runId &&
          (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.interrupted")
        ) {
          const status =
            event.type === "run.completed" ? "completed" : event.type === "run.failed" ? "failed" : "interrupted";
          messages = settleRunMessages(messages, event.runId, status);
        }
        if (
          event.runId &&
          event.data?.reason !== "queued_run_deleted" &&
          (event.type === "run.started" ||
            event.type === "run.interrupted" ||
            event.type === "run.failed" ||
            event.type === "run.completed")
        ) {
          queuedRuns = queuedRuns.filter((run) => run.runId !== event.runId);
        }
        if (event.type === "run.started" && event.runId) {
          messages = messages.map((message) =>
            message.runId === event.runId && message.role === "assistant"
              ? { ...message, status: "streaming" }
              : message
          );
        }
        const runTransition = applyRunEventState(detail, event);
        const pendingQuestion =
          event.type === "user.question"
            ? normalizeAskUserQuestion(event.data ?? event)
            : event.type === "user.answered" ||
                event.type === "run.completed" ||
                event.type === "run.failed" ||
                event.type === "run.interrupted"
              ? null
              : detail.pendingQuestion;
        return {
          ...current,
          [conversationId]: {
            ...detail,
            ...(conversationUpdate ? { title: conversationUpdate.title, updatedAt: conversationUpdate.updatedAt } : {}),
            messages,
            queuedRuns,
            pendingQuestion,
            events: [...(detail.events ?? []), event].sort(
              (a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity)
            ),
            ...runTransition
          }
        };
      });
    },
    [toast]
  );

  useEffect(() => {
    if (!selectedId || backendDown || selectedId.startsWith("local-") || !details[selectedId]) return;
    if (!cursors.current[selectedId] && details[selectedId]?.lastEventSequence) {
      cursors.current[selectedId] = String(details[selectedId].lastEventSequence);
    }
    return createEventStream(
      selectedId,
      cursors.current[selectedId],
      (event) => applyEvent(selectedId, event),
      (isConnected) => {
        setConnected(isConnected);
        if (!isConnected) {
          setDetails((current) =>
            current[selectedId]
              ? {
                  ...current,
                  [selectedId]: {
                    ...current[selectedId],
                    runState: current[selectedId].runState === "running" ? "reconnecting" : current[selectedId].runState
                  }
                }
              : current
          );
        }
      }
    );
  }, [selectedId, backendDown, applyEvent, Boolean(selectedId && details[selectedId]), streamRevision]);

  const selected = selectedId ? details[selectedId] : undefined;
  const selectedSummary = [...active, ...archived].find((item) => item.id === selectedId);
  const conversation = selected ?? (selectedSummary ? { ...selectedSummary, messages: [], events: [] } : undefined);

  const selectConversation = useCallback(
    (nextId?: string) => {
      if (nextId === selectedId) return;
      const previous = selectedId ? details[selectedId] : undefined;
      if (previous && (previous.temporary || (previous.messages.length === 0 && !previous.preview))) {
        delete drafts.current[previous.id];
        setActive((items) => items.filter((item) => item.id !== previous.id));
        setArchived((items) => items.filter((item) => item.id !== previous.id));
        setDetails((current) => {
          const next = { ...current };
          delete next[previous.id];
          return next;
        });
        if (!backendDown && !previous.id.startsWith("local-"))
          void api.deleteConversation(previous.id).catch(() => undefined);
      }
      setSelectedIdState(nextId);
    },
    [selectedId, details, backendDown]
  );

  const createConversation = useCallback(
    async (temporary = false, profileId: AgentProfileId = "graduate-admissions") => {
      let created: ConversationSummary;
      const profile = agentProfiles.find((item) => item.id === profileId);
      try {
        created = backendDown
          ? normalizeConversation({
              id: `local-${crypto.randomUUID()}`,
              title: t("newConversation"),
              state: "active",
              temporary,
              profileId,
              profileName: profile?.name
            })
          : // Pin the participant this tab believes it is showing; a stale second tab
            // must not silently create threads for whoever the global switcher points
            // at now.
            await api.createConversation(temporary, profileId, participantId);
      } catch {
        created = normalizeConversation({
          id: `local-${crypto.randomUUID()}`,
          title: t("newConversation"),
          state: "active",
          temporary,
          profileId,
          profileName: profile?.name
        });
        toast(t("localDraftCreated"), "default");
      }
      const previous = selectedId ? details[selectedId] : undefined;
      if (
        previous &&
        previous.id !== created.id &&
        (previous.temporary || (previous.messages.length === 0 && !previous.preview))
      ) {
        delete drafts.current[previous.id];
        setActive((items) => items.filter((item) => item.id !== previous.id));
        setArchived((items) => items.filter((item) => item.id !== previous.id));
        setDetails((current) => {
          const next = { ...current };
          delete next[previous.id];
          return next;
        });
        if (!backendDown && !previous.id.startsWith("local-"))
          void api.deleteConversation(previous.id).catch(() => undefined);
      }
      drafts.current[created.id] = created;
      setDetails((current) => ({ ...current, [created.id]: { ...created, messages: [], events: [] } }));
      setSelectedIdState(created.id);
      return created.id;
    },
    [backendDown, toast, selectedId, details, agentProfiles, participantId]
  );

  const updateConversation = useCallback(
    async (id: string, patch: Partial<Pick<ConversationSummary, "title" | "state" | "pinned">>) => {
      const listUpdater = (items: ConversationSummary[]) =>
        sortConversations(
          items.map((item) => (item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item))
        );
      setActive(listUpdater);
      setArchived(listUpdater);
      setDetails((current) => (current[id] ? { ...current, [id]: { ...current[id], ...patch } } : current));
      if (patch.state === "archived") {
        const item = active.find((entry) => entry.id === id);
        if (item) {
          setActive((items) => items.filter((entry) => entry.id !== id));
          setArchived((items) => sortConversations([{ ...item, ...patch }, ...items]));
        }
      } else if (patch.state === "active") {
        const item = archived.find((entry) => entry.id === id);
        if (item) {
          setArchived((items) => items.filter((entry) => entry.id !== id));
          setActive((items) => sortConversations([{ ...item, ...patch }, ...items]));
        }
      }
      if (!backendDown && !id.startsWith("local-")) {
        try {
          await api.updateConversation(id, patch);
        } catch {
          toast(t("syncFailed"), "danger");
        }
      }
    },
    [active, archived, backendDown, toast]
  );

  const updateLearningDetail = useCallback(
    (conversationId: string, learningSession: ConversationDetail["learningSession"]) => {
      setDetails((current) =>
        current[conversationId]
          ? { ...current, [conversationId]: { ...current[conversationId], learningSession } }
          : current
      );
    },
    []
  );

  const setResearchMode = useCallback(
    async (enabled: boolean) => {
      try {
        await api.updateResearchSettings(enabled);
        setResearchEnabled(enabled);
        return true;
      } catch {
        toast(t("syncFailed"), "danger");
        return false;
      }
    },
    [toast]
  );

  const createLearningSession = useCallback(
    async (input: { goal: string; topicKey?: string | null; condition?: LearningCondition | "random" }) => {
      if (!selectedId || backendDown || selectedId.startsWith("local-")) return false;
      try {
        const learningSession = await api.createLearningSession(selectedId, input);
        updateLearningDetail(selectedId, learningSession);
        return true;
      } catch {
        toast(t("syncFailed"), "danger");
        return false;
      }
    },
    [selectedId, backendDown, toast, updateLearningDetail]
  );

  const updateLearningSession = useCallback(
    async (input: {
      status?: "active" | "paused" | "completed" | "dismissed";
      goal?: string;
      topicKey?: string | null;
    }) => {
      if (!selectedId || backendDown || selectedId.startsWith("local-")) return false;
      try {
        const learningSession = await api.updateLearningSession(selectedId, input);
        updateLearningDetail(selectedId, learningSession);
        return true;
      } catch {
        toast(t("syncFailed"), "danger");
        return false;
      }
    },
    [selectedId, backendDown, toast, updateLearningDetail]
  );

  const archiveConversation = useCallback(
    async (item: ConversationSummary) => {
      const previousState = item.state;
      await updateConversation(item.id, { state: previousState === "active" ? "archived" : "active" });
      toast(previousState === "active" ? t("archivedChat") : t("restoredChat"), "success", {
        label: t("undo"),
        onClick: () => void updateConversation(item.id, { state: previousState })
      });
      if (selectedId === item.id && previousState === "active")
        setSelectedIdState(active.find((entry) => entry.id !== item.id)?.id);
    },
    [updateConversation, toast, selectedId, active]
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      const temporary = details[id]?.temporary === true;
      if (!backendDown && !id.startsWith("local-")) await api.deleteConversation(id);
      delete drafts.current[id];
      setActive((items) => items.filter((item) => item.id !== id));
      setArchived((items) => items.filter((item) => item.id !== id));
      setDetails((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (selectedId === id) setSelectedIdState(active.find((entry) => entry.id !== id)?.id);
      toast(temporary ? t("temporaryEnded") : t("chatDeleted"), "success");
    },
    [backendDown, selectedId, active, toast, details]
  );

  const appendMessage = useCallback((conversationId: string, message: ChatMessage) => {
    setDetails((current) => {
      const detail = current[conversationId];
      return detail
        ? {
            ...current,
            [conversationId]: {
              ...detail,
              messages: [...detail.messages, message],
              updatedAt: new Date().toISOString()
            }
          }
        : current;
    });
  }, []);

  const sendMessage = useCallback(
    async (content: string, mode: SendMode, attachments: Attachment[]) => {
      if (backendDown) {
        toast(t("backendUnavailable"), "danger");
        return false;
      }
      let id = selectedId;
      if (!id) id = await createConversation();
      const clientMessageId = crypto.randomUUID();
      const optimisticRunId = mode === "queue" ? `optimistic-queue-${clientMessageId}` : undefined;
      const userMessage: ChatMessage = {
        id: `optimistic-${clientMessageId}`,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        status: "completed",
        attachments,
        clientMessageId,
        ...(optimisticRunId ? { runId: optimisticRunId } : {})
      };
      appendMessage(id, userMessage);
      setDetails((current) =>
        current[id!]
          ? {
              ...current,
              [id!]: {
                ...current[id!],
                runState: mode === "queue" ? current[id!].runState : "submitting",
                ...(optimisticRunId
                  ? {
                      queuedRuns: [
                        ...(current[id!].queuedRuns ?? []),
                        { runId: optimisticRunId, userMessageId: userMessage.id }
                      ]
                    }
                  : {})
              }
            }
          : current
      );
      try {
        const response = await api.sendMessage(
          id,
          content,
          mode,
          attachments.filter((item) => item.status === "ready").map((item) => item.id),
          clientMessageId
        );
        const serverConversation = response.conversation;
        if (serverConversation) {
          if (!serverConversation.temporary) {
            setActive((items) => sortConversations([serverConversation, ...items.filter((item) => item.id !== id)]));
          }
          delete drafts.current[id];
          if (serverConversation.lastEventSequence !== undefined)
            cursors.current[id] = String(serverConversation.lastEventSequence);
          seenEvents.current[id] = new Set((serverConversation.events ?? []).map((event) => event.id));
          setDetails((current) => ({
            ...current,
            [id!]: serverConversation
          }));
          setStreamRevision((value) => value + 1);
        }
        if (!serverConversation)
          setDetails((current) =>
            current[id!]
              ? {
                  ...current,
                  [id!]: {
                    ...current[id!],
                    ...(serverConversation ?? {}),
                    runState: response.acceptedAs === "queued" ? current[id!].runState : "running",
                    activeRunId: response.acceptedAs === "queued" ? current[id!].activeRunId : response.runId
                  }
                }
              : current
          );
        return true;
      } catch (error) {
        setDetails((current) =>
          current[id!]
            ? {
                ...current,
                [id!]: {
                  ...current[id!],
                  runState: "failed",
                  messages: current[id!].messages.filter((message) => message.clientMessageId !== clientMessageId),
                  queuedRuns: (current[id!].queuedRuns ?? []).filter((run) => run.userMessageId !== userMessage.id)
                }
              }
            : current
        );
        toast(consumerSendError(error, navigator.onLine), "danger");
        return false;
      }
    },
    [selectedId, createConversation, appendMessage, backendDown, toast]
  );

  const confirmLearningVerification = useCallback(
    async (verificationId: string, verdict: "resolved" | "partial" | "unresolved") => {
      if (!selectedId || backendDown || selectedId.startsWith("local-")) return false;
      try {
        await api.confirmLearningVerification(verificationId, verdict);
        const learningSession = await api.learningSession(selectedId);
        updateLearningDetail(selectedId, learningSession);
        // One-shot baseline sessions end after the single round: recording "unresolved"
        // must not auto-request another strategy the host would reject anyway.
        if (learningSession?.condition === "one-shot") return true;
        // Mirror the Feishu card guard: only a still-diagnosed incident gets the follow-up.
        // The third unresolved round escalates the incident to a human — auto-sending the
        // try-another prompt then would burn a run and reopen teaching mid-handoff.
        // `diagnosed` is the store's way of saying another round is owed, and a "partial"
        // confirmation lands there too: gating on the verdict instead used to park those
        // incidents forever, with no round two and no closed outcome.
        const incident = learningSession?.incidents.find((item) =>
          item.verifications.some((entry) => entry.id === verificationId)
        );
        if (!incident || incident.status !== "diagnosed") return true;
        if (verdict === "resolved") return true;
        const prompt = verdict === "partial" ? t("learningPartialPrompt") : t("learningTryAnotherPrompt");
        return await sendMessage(prompt, "normal", []);
      } catch {
        toast(t("syncFailed"), "danger");
        return false;
      }
    },
    [selectedId, backendDown, toast, updateLearningDetail, sendMessage]
  );

  const applyServerConversation = useCallback((next: ConversationDetail) => {
    if (next.lastEventSequence !== undefined) cursors.current[next.id] = String(next.lastEventSequence);
    seenEvents.current[next.id] = new Set((next.events ?? []).map((event) => event.id));
    setDetails((current) => ({ ...current, [next.id]: next }));
    setActive((items) => sortConversations(items.map((item) => (item.id === next.id ? { ...item, ...next } : item))));
    setStreamRevision((value) => value + 1);
  }, []);

  const steerQueuedRun = useCallback(
    async (runId: string) => {
      if (backendDown) return false;
      try {
        const response = await api.steerQueuedRun(runId);
        if (response.conversation) applyServerConversation(response.conversation);
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : t("cannotGuide"), "danger");
        return false;
      }
    },
    [backendDown, toast, applyServerConversation]
  );

  const updateQueuedRun = useCallback(
    async (runId: string, content: string) => {
      const id = selectedId;
      if (!id) return false;
      if (backendDown || runId.startsWith("optimistic-")) {
        setDetails((current) =>
          current[id]
            ? {
                ...current,
                [id]: {
                  ...current[id],
                  messages: current[id].messages.map((message) =>
                    message.runId === runId && message.role === "user" ? { ...message, content } : message
                  )
                }
              }
            : current
        );
        return true;
      }
      try {
        const response = await api.updateQueuedRun(runId, content);
        if (response.conversation) applyServerConversation(response.conversation);
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : t("cannotEditQueue"), "danger");
        return false;
      }
    },
    [backendDown, selectedId, toast, applyServerConversation]
  );

  const deleteQueuedRun = useCallback(
    async (runId: string) => {
      const id = selectedId;
      if (!id) return false;
      if (backendDown || runId.startsWith("optimistic-")) {
        setDetails((current) =>
          current[id]
            ? {
                ...current,
                [id]: {
                  ...current[id],
                  messages: current[id].messages.filter((message) => message.runId !== runId),
                  queuedRuns: (current[id].queuedRuns ?? []).filter((run) => run.runId !== runId)
                }
              }
            : current
        );
        return true;
      }
      try {
        const response = await api.deleteQueuedRun(runId);
        if (response.conversation) applyServerConversation(response.conversation);
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : t("cannotDeleteQueue"), "danger");
        return false;
      }
    },
    [backendDown, selectedId, toast, applyServerConversation]
  );

  const interrupt = useCallback(async () => {
    if (!conversation?.activeRunId) return;
    const id = conversation.id;
    setDetails((current) => ({ ...current, [id]: { ...current[id], runState: "interrupting" } }));
    try {
      if (!backendDown) await api.interrupt(conversation.activeRunId);
      setDetails((current) => ({
        ...current,
        [id]: {
          ...current[id],
          runState: "interrupted",
          activeRunId: undefined,
          pendingQuestion: null,
          messages: current[id].messages.map((message) =>
            message.status === "streaming" ? { ...message, status: "interrupted" } : message
          )
        }
      }));
    } catch {
      setDetails((current) => ({ ...current, [id]: { ...current[id], runState: "running" } }));
      toast(t("cannotPause"), "danger");
    }
  }, [conversation, backendDown, toast]);

  const answerQuestion = useCallback(
    async (answers: Record<string, string>) => {
      if (!conversation?.activeRunId || backendDown) return;
      const id = conversation.id;
      try {
        await api.answerQuestion(conversation.activeRunId, answers);
        setDetails((current) =>
          current[id] ? { ...current, [id]: { ...current[id], pendingQuestion: null } } : current
        );
      } catch {
        toast(t("answerFailed"), "danger");
      }
    },
    [conversation, backendDown, toast]
  );

  const retryMessage = useCallback(
    async (message: ChatMessage) => {
      if (backendDown) {
        toast(t("backendUnavailable"), "danger");
        return;
      }
      const previousDetail = conversation;
      const sourceIndex = conversation?.messages.findIndex((item) => item.id === message.id) ?? -1;
      const placeholderId = `retry-${crypto.randomUUID()}`;
      if (conversation && sourceIndex >= 0) {
        setDetails((current) => ({
          ...current,
          [conversation.id]: {
            ...current[conversation.id],
            messages: [
              ...conversation.messages.slice(0, sourceIndex),
              {
                ...message,
                id: placeholderId,
                content: "",
                status: "streaming",
                createdAt: new Date().toISOString()
              }
            ],
            runState: "submitting",
            activeRunId: undefined,
            updatedAt: new Date().toISOString()
          }
        }));
      }
      try {
        const result = await api.retryMessage(message.id);
        if (!result.conversation || !result.runId) throw new Error("Retry response is missing its conversation");
        const next: ConversationDetail = {
          ...result.conversation,
          runState: "running",
          activeRunId: result.runId
        };
        if (next.lastEventSequence !== undefined) cursors.current[next.id] = String(next.lastEventSequence);
        seenEvents.current[next.id] = new Set((next.events ?? []).map((event) => event.id));
        setDetails((current) => ({ ...current, [next.id]: next }));
        setActive((items) => sortConversations([next, ...items.filter((item) => item.id !== next.id)]));
        setArchived((items) => items.filter((item) => item.id !== next.id));
        setSelectedIdState(next.id);
        setStreamRevision((value) => value + 1);
      } catch {
        if (previousDetail) setDetails((current) => ({ ...current, [previousDetail.id]: previousDetail }));
        toast(t("cannotRegenerate"), "danger");
      }
    },
    [backendDown, conversation, toast]
  );

  const adoptConversation = useCallback((next: ConversationDetail) => {
    setDetails((current) => ({ ...current, [next.id]: next }));
    setActive((items) => sortConversations([next, ...items.filter((item) => item.id !== next.id)]));
    setArchived((items) => items.filter((item) => item.id !== next.id));
    setSelectedIdState(next.id);
    setStreamRevision((value) => value + 1);
  }, []);

  const startLearningDemoScenario = useCallback(
    async (
      scenarioId: string,
      executionMode: "deterministic" | "agent",
      condition: "on-call" | "one-shot" | "multi-turn" = "on-call"
    ) => {
      if (backendDown) return false;
      try {
        const next = await api.startLearningDemoScenario(scenarioId, executionMode, condition);
        if (!next) throw new Error("Learning demo response is missing its conversation");
        adoptConversation(next);
        return true;
      } catch {
        toast(t("syncFailed"), "danger");
        return false;
      }
    },
    [adoptConversation, backendDown, toast]
  );

  const replayRunById = useCallback(
    async (runId: string, options?: { includeArtifactId?: string }) => {
      if (backendDown) return false;
      try {
        const result = await api.replayRun(runId, options);
        if (!result.conversation) throw new Error("Replay response is missing its conversation");
        adoptConversation(result.conversation);
        toast(t("replayOpened"), "success");
        return true;
      } catch {
        toast(t("replayFailed"), "danger");
        return false;
      }
    },
    [adoptConversation, backendDown, toast]
  );

  const replayRun = useCallback(
    async (message: ChatMessage) => {
      if (!message.runId) return;
      await replayRunById(message.runId);
    },
    [replayRunById]
  );

  const branchMessage = useCallback(
    async (message: ChatMessage, content?: string, asNewConversation = false) => {
      if (backendDown) {
        toast(t("backendUnavailable"), "danger");
        return;
      }
      // An optimistic message has no server id yet, so there is nothing to branch from.
      if (message.id.startsWith("optimistic-")) {
        toast(t("cannotBranch"), "danger");
        return;
      }
      const editedContent = content?.trim();
      const editingCurrentTurn = Boolean(
        !asNewConversation && editedContent && message.role === "user" && conversation
      );
      const previousDetail = editingCurrentTurn ? conversation : undefined;

      if (editingCurrentTurn && conversation && editedContent) {
        const sourceIndex = conversation.messages.findIndex((item) => item.id === message.id);
        if (sourceIndex >= 0) {
          const optimisticMessage: ChatMessage = {
            ...message,
            id: `optimistic-edit-${crypto.randomUUID()}`,
            content: editedContent,
            createdAt: new Date().toISOString(),
            status: "completed"
          };
          setDetails((current) => ({
            ...current,
            [conversation.id]: {
              ...current[conversation.id],
              messages: [...conversation.messages.slice(0, sourceIndex), optimisticMessage],
              runState: "submitting",
              activeRunId: undefined,
              updatedAt: new Date().toISOString()
            }
          }));
        }
      }

      try {
        const result = await api.branchMessage(message.id, editedContent, asNewConversation);
        if (!result.conversation) throw new Error("Branch response is missing its conversation");
        const next: ConversationDetail = {
          ...result.conversation,
          runState: result.runId ? "running" : result.conversation.runState,
          activeRunId: result.runId ?? result.conversation.activeRunId
        };
        if (next.lastEventSequence !== undefined) cursors.current[next.id] = String(next.lastEventSequence);
        seenEvents.current[next.id] = new Set((next.events ?? []).map((event) => event.id));
        setDetails((current) => ({ ...current, [next.id]: next }));
        if (next.state === "archived") {
          setArchived((items) => sortConversations([next, ...items.filter((item) => item.id !== next.id)]));
          setActive((items) => items.filter((item) => item.id !== next.id));
        } else {
          setActive((items) => sortConversations([next, ...items.filter((item) => item.id !== next.id)]));
          setArchived((items) => items.filter((item) => item.id !== next.id));
        }
        setSelectedIdState(next.id);
        setStreamRevision((value) => value + 1);
      } catch {
        if (previousDetail) setDetails((current) => ({ ...current, [previousDetail.id]: previousDetail }));
        toast(editingCurrentTurn ? t("cannotUpdateMessage") : t("cannotBranch"), "danger");
      }
    },
    [backendDown, conversation, toast]
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      let conversationId = selectedId;
      if (!conversationId) conversationId = await createConversation();
      const limits = capabilities.attachments;
      const accepted = files.slice(0, limits?.maxFiles ?? 8);
      const oversized = accepted.filter((file) => limits?.maxBytes && file.size > limits.maxBytes);
      if (oversized.length) toast(t("filesTooLarge", { count: oversized.length }), "danger");
      return Promise.all(
        accepted
          .filter((file) => !limits?.maxBytes || file.size <= limits.maxBytes)
          .map(async (file) => {
            const local: Attachment = {
              id: `upload-${crypto.randomUUID()}`,
              name: file.name,
              size: file.size,
              type: file.type,
              status: "uploading"
            };
            if (backendDown) return { ...local, status: "failed" as const };
            try {
              return await api.uploadAttachment(conversationId!, file);
            } catch {
              return { ...local, status: "failed" as const };
            }
          })
      );
    },
    [capabilities, backendDown, toast, selectedId, createConversation]
  );

  const removeAttachment = useCallback(
    async (attachment: Attachment) => {
      if (!backendDown && !attachment.id.startsWith("upload-"))
        await api.deleteAttachment(attachment.id).catch(() => undefined);
    },
    [backendDown]
  );

  return {
    capabilities,
    refreshCapabilities,
    agentProfiles,
    active,
    archived,
    conversation,
    selectedId,
    setSelectedId: selectConversation,
    searchQuery,
    setSearchQuery,
    loading,
    demoMode,
    backendDown,
    connected,
    toasts,
    dismissToast,
    createConversation,
    updateConversation,
    archiveConversation,
    deleteConversation,
    sendMessage,
    steerQueuedRun,
    updateQueuedRun,
    deleteQueuedRun,
    interrupt,
    answerQuestion,
    retryMessage,
    replayRun,
    replayRunById,
    adoptConversation,
    branchMessage,
    uploadFiles,
    removeAttachment,
    researchEnabled,
    researchStudy,
    participants,
    participantId,
    switchParticipant,
    addParticipant,
    setResearchMode,
    createLearningSession,
    updateLearningSession,
    confirmLearningVerification,
    startLearningDemoScenario,
    toast
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
