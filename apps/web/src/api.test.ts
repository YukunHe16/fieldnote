import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  normalizeAssistantBlock,
  normalizeCollaborationTrace,
  normalizeConversation,
  normalizeConversationDetail,
  normalizeEvent,
  normalizeFeishuSenderCandidate,
  normalizeLearningDemoScenario,
  normalizeLearningPolicy,
  normalizeLearningSession,
  normalizeMemory,
  normalizeMessage
} from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("API normalizers", () => {
  it("accepts snake_case conversation fields and preserves unknown fields", () => {
    const conversation = normalizeConversation({
      id: "c1",
      title: "测试",
      state: "archived",
      updated_at: "2026-08-18T00:00:00Z",
      run_state: "running",
      futureField: 42
    });
    expect(conversation).toMatchObject({ id: "c1", state: "archived", runState: "running", futureField: 42 });
    expect(normalizeConversation({ id: "c2", status: "queued" }).runState).toBe("submitting");
  });

  it("normalizes message attachments without rejecting extra fields", () => {
    const message = normalizeMessage({
      id: "m1",
      role: "user",
      text: "hello",
      created_at: "2026-08-18T00:00:00Z",
      attachments: [{ id: "a1", filename: "brief.pdf", custom: true }]
    });
    expect(message.content).toBe("hello");
    expect(message.attachments?.[0]).toMatchObject({
      id: "a1",
      name: "brief.pdf",
      custom: true,
      url: "/api/attachments/a1"
    });
  });

  it("normalizes temporary conversations and memory references", () => {
    const conversation = normalizeConversation({ id: "temp", temporary: true, expires_at: "2026-08-19T00:00:00Z" });
    const message = normalizeMessage({
      id: "m2",
      role: "assistant",
      content: "done",
      memory_references: [
        {
          memory_id: "memory-1",
          category: "project",
          title: "站点重构",
          content: "继续完成导航",
          source: {
            id: "s1",
            conversation_id: "c1",
            conversation_title: "规划",
            excerpt: "导航方案",
            created_at: "2026-08-18T00:00:00Z"
          }
        }
      ]
    });
    expect(conversation).toMatchObject({ temporary: true, expiresAt: "2026-08-19T00:00:00Z" });
    expect(message.memoryReferences?.[0]).toMatchObject({
      memoryId: "memory-1",
      category: "project",
      source: { conversationId: "c1", sourceDeleted: false }
    });
    expect(
      normalizeMessage({ id: "m3", role: "assistant", content: "ok", skill_references: ["资料调研", "报告写作"] })
        .skillReferences
    ).toEqual(["资料调研", "报告写作"]);
  });

  it("normalizes collaboration traces without carrying unsafe source URLs", () => {
    const trace = normalizeCollaborationTrace({
      tasks: [
        {
          id: "task-1",
          run_id: "run-1",
          assistant_message_id: "message-1",
          specialist_id: "verifier",
          display_name: "来源核验",
          request_summary: "核验截止日期",
          status: "completed",
          result_summary: "已核验",
          structured: true,
          result: {
            summary: "官方页面已核验",
            findings: [
              {
                claim: "截止日期为 12 月 1 日",
                status: "verified",
                source_urls: ["https://example.edu/deadline", "javascript:alert(1)"]
              }
            ],
            open_questions: ["是否接受晚交？"],
            recommended_followups: [{ specialist_id: "researcher", question: "确认例外条款" }]
          }
        }
      ],
      handoffs: [
        {
          id: "handoff-1",
          run_id: "run-1",
          source_task_id: "task-1",
          target_task_id: "task-2",
          question: "复核例外条款",
          status: "running"
        }
      ],
      summary: { specialist_count: 2, verified_count: 1, conflicting_count: 0, unresolved_count: 1, source_count: 1 }
    });
    expect(trace).toMatchObject({
      summary: { specialistCount: 2, verifiedCount: 1, sourceCount: 1 },
      tasks: [{ result: { findings: [{ sourceUrls: ["https://example.edu/deadline"] }] } }],
      handoffs: [{ question: "复核例外条款", status: "running" }]
    });
    expect(normalizeCollaborationTrace({ tasks: [], handoffs: [], summary: { specialistCount: 99 } })).toBeNull();
    expect(normalizeMessage({ id: "assistant-collab", collaboration: trace }).collaboration).toEqual(trace);
  });

  it("normalizes memory defaults and deleted sources", () => {
    const memory = normalizeMemory({
      id: "memory-1",
      category: "preference",
      title: "回答风格",
      content: "简洁",
      sources: [{ id: "s1", conversation_id: null }]
    });
    expect(memory).toMatchObject({
      importance: 3,
      pinned: false,
      sourceKind: "auto",
      scope: "global",
      profileId: null
    });
    expect(memory.sources[0]).toMatchObject({ conversationId: null, sourceDeleted: true });
  });

  it("normalizes nested assistant activity blocks with snake case fields", () => {
    const block = normalizeAssistantBlock({
      activity_id: "a1",
      kind: "subagent",
      status: "running",
      technical_name: "local-operator",
      children: [{ block_id: "a2", type: "mcp", status: "completed", duration_ms: 320, output_summary: "已读取项目" }]
    });
    expect(block).toMatchObject({
      id: "a1",
      type: "subagent",
      status: "running",
      technicalName: "local-operator"
    });
    expect(block.children[0]).toMatchObject({ id: "a2", type: "mcp", durationMs: 320, outputSummary: "已读取项目" });
  });

  it("normalizes a learning session with incidents, interventions, and verification outcomes", () => {
    const session = normalizeLearningSession({
      id: "session-1",
      conversation_id: "c1",
      profile_id: "local-operator",
      goal: "Understand recursion",
      topic_key: "programming",
      status: "active",
      dataset_kind: "live",
      execution_mode: "agent",
      incidents: [
        {
          id: "incident-1",
          session_id: "session-1",
          difficulty_type: "conceptual_misconception",
          hypothesis: "Base case is unclear",
          confidence: 0.8,
          severity: 2,
          evidence_message_ids: ["m1"],
          status: "verifying",
          interventions: [
            {
              id: "intervention-1",
              incident_id: "incident-1",
              strategy: "worked_example",
              expected_signal: "Can explain a new example",
              rationale: "Contrast the cases",
              round: 1
            }
          ],
          verifications: [
            {
              id: "verification-1",
              incident_id: "incident-1",
              method: "transfer_example",
              prompt: "Trace a new call",
              rubric: "Names the base case",
              system_verdict: "partial",
              system_confidence: 0.7,
              proposed_message_id: "m2"
            }
          ]
        }
      ]
    });
    expect(session).toMatchObject({
      id: "session-1",
      conversationId: "c1",
      topicKey: "programming",
      executionMode: "agent",
      incidents: [
        {
          difficultyType: "conceptual_misconception",
          interventions: [{ strategy: "worked_example" }],
          verifications: [{ systemVerdict: "partial", proposedMessageId: "m2" }]
        }
      ]
    });
    expect(normalizeLearningSession({ id: "legacy-demo", datasetKind: "demo", incidents: [] })?.executionMode).toBe(
      "deterministic"
    );
    expect(normalizeLearningSession({ id: "legacy-replay", datasetKind: "replay", incidents: [] })?.executionMode).toBe(
      "agent"
    );
  });

  it("uses learning session, confirmation, and policy endpoints", async () => {
    const jsonResponse = (body: object) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          session: {
            id: "s1",
            conversationId: "c1",
            profileId: "local-operator",
            goal: "Learn",
            status: "active",
            datasetKind: "live",
            incidents: []
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          verification: {
            id: "v1",
            incidentId: "i1",
            method: "user_report",
            prompt: "",
            rubric: "",
            finalVerdict: "resolved"
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ policies: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await api.createLearningSession("c1", { goal: "Learn", topicKey: "systems" });
    await api.confirmLearningVerification("v1", "resolved");
    await api.learningPolicies({ profileId: "local-operator", topicKey: "systems" });
    expect(
      fetchMock.mock.calls.map(([path, init]) => [path, init?.method, init?.body && JSON.parse(String(init.body))])
    ).toEqual([
      ["/api/conversations/c1/learning-session", "POST", { goal: "Learn", topicKey: "systems" }],
      ["/api/learning/verifications/v1/confirm", "POST", { verdict: "resolved" }],
      ["/api/learning/policies?profileId=local-operator&datasetKind=live&topicKey=systems", undefined, undefined]
    ]);
  });

  it("normalizes deterministic policy previews from frozen incident snapshots", () => {
    expect(
      normalizeLearningPolicy({
        id: "policy-1",
        profile_id: "local-operator",
        difficulty_type: "planning_gap",
        dataset_kind: "demo",
        ordered_strategies: ["contrastive_example"],
        evidence_experience_ids: ["experience-1"],
        status: "pending",
        preview: {
          current_first_strategy: "socratic_question",
          candidate_first_strategy: "contrastive_example",
          snapshot_count: 6,
          changed_selection_count: 5,
          comparisons: []
        }
      })
    ).toMatchObject({
      preview: {
        currentFirstStrategy: "socratic_question",
        candidateFirstStrategy: "contrastive_example",
        snapshotCount: 6,
        changedSelectionCount: 5
      }
    });
  });

  it("lists and starts explicitly synthetic learning demos", async () => {
    expect(
      normalizeLearningDemoScenario({
        id: "planning-gap",
        title: "Code planning",
        description: "A synthetic scenario",
        preview: "flatten([]) → IndexError",
        loop: "Plan → intervene → verify",
        goal: "Plan first",
        topic_key: "programming",
        difficulty_type: "planning_gap",
        synthetic: false,
        agent_available: true
      })
    ).toMatchObject({
      id: "planning-gap",
      preview: "flatten([]) → IndexError",
      loop: "Plan → intervene → verify",
      topicKey: "programming",
      difficultyType: "planning_gap",
      synthetic: true,
      agentAvailable: true
    });
    const jsonResponse = (body: object) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          scenarios: [
            {
              id: "planning-gap",
              title: "Code planning",
              description: "A synthetic scenario",
              preview: "flatten([]) → IndexError",
              loop: "Plan → intervene → verify",
              goal: "Plan first",
              topicKey: "programming",
              difficultyType: "planning_gap",
              synthetic: true,
              agentAvailable: true
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          conversation: {
            id: "demo-c1",
            title: "Synthetic demo",
            profileId: "local-operator",
            messages: [],
            learningSession: {
              id: "demo-s1",
              conversationId: "demo-c1",
              profileId: "local-operator",
              goal: "Plan first",
              status: "active",
              datasetKind: "demo",
              executionMode: "agent",
              incidents: []
            }
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const scenarios = await api.learningDemoScenarios();
    const conversation = await api.startLearningDemoScenario(scenarios[0]!.id, "agent");
    expect(scenarios[0]).toMatchObject({
      synthetic: true,
      difficultyType: "planning_gap",
      preview: "flatten([]) → IndexError",
      loop: "Plan → intervene → verify",
      agentAvailable: true
    });
    expect(conversation).toMatchObject({
      id: "demo-c1",
      learningSession: { datasetKind: "demo", executionMode: "agent" }
    });
    expect(
      fetchMock.mock.calls.map(([path, init]) => [path, init?.method, init?.body && JSON.parse(String(init.body))])
    ).toEqual([
      ["/api/learning/demo-scenarios", undefined, undefined],
      ["/api/learning/demo-scenarios/planning-gap/start", "POST", { executionMode: "agent", condition: "on-call" }]
    ]);
    const startInit = fetchMock.mock.calls[1]?.[1];
    expect((startInit?.headers as Headers | undefined)?.get("Content-Type")).toBe("application/json");
  });

  it("directly supports canonical flat AssistantBlockDto and nests parent blocks", () => {
    const message = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "",
      blocks: [
        {
          id: "parent",
          runId: "r1",
          messageId: "assistant-1",
          parentBlockId: null,
          owner: "subagent",
          kind: "subagent",
          order: 1,
          content: "",
          activity: {
            id: "act-1",
            parentActivityId: null,
            kind: "subagent",
            displayName: "资料研究",
            technicalName: "delegate_research",
            status: "running",
            content: "检索中",
            inputSummary: "来源 A",
            outputSummary: "",
            startedAt: "2026-08-18T00:00:00Z",
            completedAt: null
          }
        },
        {
          id: "child",
          runId: "r1",
          messageId: "assistant-1",
          parentBlockId: "parent",
          owner: "subagent",
          kind: "activity",
          order: 2,
          content: "",
          activity: {
            id: "act-2",
            parentActivityId: "act-1",
            kind: "mcp",
            displayName: "读取网页",
            technicalName: "WebFetch",
            status: "completed",
            content: "",
            inputSummary: "URL",
            outputSummary: "已验证",
            startedAt: "2026-08-18T00:00:01Z",
            completedAt: "2026-08-18T00:00:02Z"
          }
        }
      ]
    });
    expect(message.blocks?.[0]).toMatchObject({
      id: "parent",
      type: "subagent",
      status: "running",
      title: "资料研究",
      technicalName: "delegate_research"
    });
    expect(message.blocks?.[0]?.children[0]).toMatchObject({
      id: "child",
      type: "mcp",
      status: "completed",
      outputSummary: "已验证"
    });
  });

  it("sends the locked profileId and temporary conversation protocol", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "c-profile",
          title: "新对话",
          profileId: "local-operator",
          temporary: true,
          updatedAt: "2026-08-18T00:00:00Z"
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const conversation = await api.createConversation(true, "local-operator");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      profileId: "local-operator",
      temporary: true
    });
    expect(conversation).toMatchObject({ id: "c-profile", profileId: "local-operator", temporary: true });
  });

  it("flattens nested SSE payloads and safely labels unknown events", () => {
    expect(normalizeEvent({ id: "e1", type: "text.delta", data: { message_id: "m1", delta: "片段" } })).toMatchObject({
      id: "e1",
      type: "text.delta",
      messageId: "m1",
      content: "片段"
    });
    expect(
      normalizeEvent({ id: "memory-event", type: "memory.recalled", payload: { references: [{ memoryId: "m1" }] } })
    ).toMatchObject({ data: { references: [{ memoryId: "m1" }] } });
    expect(normalizeEvent({ unexpected: true }).type).toBe("agent.unknown");
  });

  it("normalizes a branched conversation with its replacement messages", () => {
    const conversation = normalizeConversationDetail({
      id: "c1",
      title: "编辑后的对话",
      archived: false,
      updatedAt: "2026-08-18T00:00:00Z",
      messages: [
        { id: "new-user", role: "user", content: "新的问题", createdAt: "2026-08-18T00:00:01Z" },
        { id: "new-agent", role: "assistant", content: "", status: "queued", createdAt: "2026-08-18T00:00:02Z" }
      ],
      events: [
        {
          eventId: "e1",
          type: "run.status",
          sequence: 1,
          timestamp: "2026-08-18T00:00:03Z",
          payload: { status: "queued" }
        }
      ],
      queuedRuns: [{ run_id: "r2", user_message_id: "new-user" }]
    });
    expect(conversation.messages.map((message) => message.id)).toEqual(["new-user", "new-agent"]);
    expect(conversation.messages[1]?.status).toBe("streaming");
    expect(conversation.events?.[0]).toMatchObject({ id: "e1", status: "queued" });
    expect(conversation.queuedRuns).toEqual([{ runId: "r2", userMessageId: "new-user" }]);
  });

  it("reads recent Feishu senders and drops entries without an open_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { openId: "ou_me", chatType: "p2p", authorized: true, lastSeenAt: "2026-08-18T00:00:00Z" },
            { open_id: "ou_other", chat_type: "p2p", authorized: false, last_seen_at: "2026-08-17T00:00:00Z" },
            { chatType: "p2p", authorized: false }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await api.feishuSenderCandidates();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/channels/feishu/candidates");
    expect(candidates).toEqual([
      { openId: "ou_me", chatType: "p2p", authorized: true, lastSeenAt: "2026-08-18T00:00:00Z" },
      { openId: "ou_other", chatType: "p2p", authorized: false, lastSeenAt: "2026-08-17T00:00:00Z" }
    ]);
    expect(normalizeFeishuSenderCandidate({ openId: "ou_group", chatType: "group" })).toEqual({
      openId: "ou_group",
      chatType: "group",
      authorized: false,
      lastSeenAt: ""
    });
  });
});
