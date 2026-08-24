import type {
  LearningDifficultyType,
  LearningIncidentDto,
  LearningInterventionStrategy,
  LearningOutcome,
  LearningStore,
  LearningVerificationMethod
} from "./learning-store.js";

export interface DemoLearningTurnInput {
  conversationId: string;
  runId: string;
  userMessageId: string;
  assistantMessageId: string;
  prompt: string;
  locale?: "zh" | "en";
}

export interface DemoLearningTurnResult {
  incident: LearningIncidentDto;
  response: string;
  phase: "verification_requested" | "outcome_proposed";
}

export class LearningCoordinator {
  constructor(private readonly store: LearningStore) {}

  getSessionForConversation(...args: Parameters<LearningStore["getSessionForConversation"]>) {
    return this.store.getSessionForConversation(...args);
  }
  getIncident(...args: Parameters<LearningStore["getIncident"]>) {
    return this.store.getIncident(...args);
  }
  getSessionForIncident(...args: Parameters<LearningStore["getSessionForIncident"]>) {
    return this.store.getSessionForIncident(...args);
  }
  listIncidents(...args: Parameters<LearningStore["listIncidents"]>) {
    return this.store.listIncidents(...args);
  }
  listInterventions(...args: Parameters<LearningStore["listInterventions"]>) {
    return this.store.listInterventions(...args);
  }
  listVerifications(...args: Parameters<LearningStore["listVerifications"]>) {
    return this.store.listVerifications(...args);
  }
  selectStrategy(...args: Parameters<LearningStore["selectStrategy"]>) {
    return this.store.selectStrategy(...args);
  }
  openIncident(...args: Parameters<LearningStore["openIncident"]>) {
    return this.store.openIncident(...args);
  }
  recordIntervention(...args: Parameters<LearningStore["recordIntervention"]>) {
    return this.store.recordIntervention(...args);
  }
  requestVerification(...args: Parameters<LearningStore["requestVerification"]>) {
    return this.store.requestVerification(...args);
  }
  proposeSystemOutcome(...args: Parameters<LearningStore["proposeSystemOutcome"]>) {
    return this.store.proposeSystemOutcome(...args);
  }
  escalateIncident(...args: Parameters<LearningStore["escalateIncident"]>) {
    return this.store.escalateIncident(...args);
  }
  offerVariant(...args: Parameters<LearningStore["offerVariant"]>) {
    return this.store.offerVariant(...args);
  }

  advanceDemoTurn(input: DemoLearningTurnInput): DemoLearningTurnResult | null {
    const session = this.store.getSessionForConversation(input.conversationId);
    if (!session || session.status !== "active" || session.datasetKind !== "demo") return null;
    const incidents = this.store.listIncidents(session.id);
    const current =
      [...incidents]
        .reverse()
        .find((incident) => ["observing", "diagnosed", "intervening", "verifying"].includes(incident.status)) ?? null;
    if (current?.status === "verifying") return this.proposeDemoOutcome(current, input);
    if (current && ["diagnosed", "intervening"].includes(current.status)) {
      return this.createDemoIntervention(current, session.profileId, session.topicKey, session.datasetKind, input);
    }
    if (incidents.some((incident) => isCompletedInteractiveDemoIncident(incident))) return null;

    const difficultyType = incidents[0]?.difficultyType ?? "other";
    const incident = this.store.openIncident({
      sessionId: session.id,
      difficultyType,
      hypothesis: demoCopy(session.topicKey, input.locale).hypothesis,
      confidence: 0.82,
      severity: 3,
      evidenceMessageIds: [input.userMessageId],
      runId: input.runId
    });
    return this.createDemoIntervention(incident, session.profileId, session.topicKey, session.datasetKind, input);
  }

  private createDemoIntervention(
    incident: LearningIncidentDto,
    profileId: string,
    topicKey: string | null,
    datasetKind: "demo",
    input: DemoLearningTurnInput
  ): DemoLearningTurnResult {
    const interventions = this.store.listInterventions(incident.id);
    const selection = this.store.selectStrategy({
      profileId,
      topicKey,
      difficultyType: incident.difficultyType,
      datasetKind,
      failedStrategies: interventions.map((item) => item.strategy)
    });
    const copy = demoCopy(topicKey, input.locale, selection.strategy);
    const intervention = this.store.recordIntervention({
      incidentId: incident.id,
      strategy: selection.strategy,
      rationale: copy.rationale,
      expectedSignal: copy.expectedSignal,
      ...(selection.policyRevisionId ? { policyRevisionId: selection.policyRevisionId } : {}),
      runId: input.runId,
      messageId: input.assistantMessageId
    });
    const _verification = this.store.requestVerification({
      incidentId: incident.id,
      interventionId: intervention.id,
      method: verificationMethod(incident.difficultyType),
      prompt: copy.verificationPrompt,
      rubric: copy.rubric,
      runId: input.runId,
      messageId: input.assistantMessageId
    });
    return {
      incident: this.store.getIncident(incident.id)!,
      phase: "verification_requested",
      response: `${copy.explanation}\n\n${copy.verificationPrompt}`
    };
  }

  private proposeDemoOutcome(
    incident: LearningIncidentDto,
    input: DemoLearningTurnInput
  ): DemoLearningTurnResult | null {
    const verification = [...this.store.listVerifications(incident.id)].reverse().find((item) => !item.systemVerdict);
    if (!verification) return null;
    const session = this.store.getSessionForIncident(incident.id);
    const locale = input.locale ?? "zh";
    const assessment = evaluateDemoAnswer(session?.topicKey ?? null, input.prompt, locale);
    this.store.proposeSystemOutcome(verification.id, assessment.verdict, assessment.confidence, {
      runId: input.runId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId
    });
    const copy = demoCopy(session?.topicKey ?? null, locale);
    return {
      incident: this.store.getIncident(incident.id)!,
      phase: "outcome_proposed",
      response: `${assessment.feedback}\n\n${copy.outcomePrompt}`
    };
  }
}

function verificationMethod(difficultyType: LearningDifficultyType): LearningVerificationMethod {
  if (difficultyType === "planning_gap") return "prediction";
  if (difficultyType === "feedback_uncertainty") return "comparison";
  return "transfer_example";
}

function isCompletedInteractiveDemoIncident(incident: LearningIncidentDto): boolean {
  const snapshot = incident.closedSnapshot;
  return Boolean(snapshot && typeof snapshot === "object" && (snapshot as { synthetic?: unknown }).synthetic !== true);
}

function demoCopy(topicKey: string | null, locale: "zh" | "en" = "zh", strategy?: LearningInterventionStrategy) {
  const english = locale === "en";
  const strategyLabel = english ? englishStrategy(strategy) : chineseStrategy(strategy);
  if (topicKey === "programming-plans")
    return english
      ? {
          hypothesis:
            "The learner is patching items[0] before defining the empty-list base case and recursive decomposition.",
          rationale: `Use ${strategyLabel} to separate planning from implementation.`,
          expectedSignal:
            "The learner can name the empty-list result, first/rest reduction, and concatenation rule before editing code.",
          explanation: `Let's slow the recursion down and watch where it actually fails.

**1. Follow one real call**

\`flatten([1, [2, 3]])\`
→ \`[1] + flatten([[2, 3]])\`
→ \`[1] + (flatten([2, 3]) + flatten([]))\`

The empty list is not a surprise error. Every non-empty list eventually has an empty \`rest\`, so \`flatten([])\` is a normal input the function must understand.

**2. Decide what the smallest input means**

An empty list contains nothing to flatten, so its flattened result should be \`[]\`. This choice also fits concatenation: \`[] + [4]\` is still \`[4]\`.

**3. State how the problem gets smaller**

For a non-empty list, separate \`first\` from \`rest\`. The \`rest\` is strictly shorter. If \`first\` is itself a list, flatten that smaller nested list too. Repeating this process eventually reaches \`[]\`.

**4. Put the pieces back together**

Flatten the first part, flatten the rest, then concatenate the two results. For the original example, \`[1]\` combined with \`[2, 3]\` gives \`[1, 2, 3]\`.

That is the recursive plan. Exception handling is unnecessary because the empty list is a valid case with a defined answer, not an exceptional failure.`,
          verificationPrompt: `Now try the same plan on \`flatten([[], 4])\`. Fill in these five steps:

- **first:** \`?\`

- **rest:** \`?\`

- **flatten(first):** \`?\`

- **flatten(rest):** \`?\`

- **concatenated result:** \`?\`

Finish with one sentence explaining why the empty-list case lets the recursion stop.`,
          rubric:
            "States that the empty list returns []; decomposes work into first/rest recursive subproblems; concatenates the flattened results.",
          outcomePrompt:
            "Does the idea now feel clear, partly clear, or still confusing? Choose honestly below; if it is still unclear, I will teach it another way."
        }
      : {
          hypothesis: "当前在定义空列表出口和递归拆分前，就开始修补 items[0] 的异常。",
          rationale: `用${strategyLabel}把计划与实现分开。`,
          expectedSignal: "学习者能在改代码前说出空列表结果、first/rest 缩小方式和拼接规则。",
          explanation: `先别改代码，我们把递归放慢，看看它究竟在哪里出错。

**1. 跟着一个真实输入往下走**

\`flatten([1, [2, 3]])\`
→ \`[1] + flatten([[2, 3]])\`
→ \`[1] + (flatten([2, 3]) + flatten([]))\`

这里的空列表不是意外。任何非空列表不断取 \`rest\`，最后都会得到 \`[]\`，所以 \`flatten([])\` 是函数必须处理的正常输入。

**2. 先决定最小输入应该得到什么**

空列表里没有元素需要展平，所以结果应该是 \`[]\`。这个结果也正好适合拼接：\`[] + [4]\` 仍然是 \`[4]\`。

**3. 再说明问题怎样变小**

对非空列表，先拆成 \`first\` 和 \`rest\`。\`rest\` 一定比原列表短；如果 \`first\` 本身还是列表，就继续展平这个更小的嵌套列表。这样反复进行，最终一定会走到 \`[]\`。

**4. 最后把结果组合回来**

先得到 first 部分的展平结果，再得到 rest 的展平结果，然后把两边拼接。原例中就是把 \`[1]\` 与 \`[2, 3]\` 拼成 \`[1, 2, 3]\`。

这才是递归计划。空列表是有明确定义的正常情况，不需要用异常处理把它藏起来。`,
          verificationPrompt: `现在用同一套思路分析 \`flatten([[], 4])\`。请依次填出：

- **first：**\`?\`

- **rest：**\`?\`

- **flatten(first)：**\`?\`

- **flatten(rest)：**\`?\`

- **两边拼接后的结果：**\`?\`

最后再用一句话解释：为什么空列表出口能让递归停下来？`,
          rubric: "说明空列表返回 []；把问题拆成 first/rest 的递归子问题；拼接两边展平结果。",
          outcomePrompt:
            "现在这套思路对你来说是清楚、部分清楚，还是仍然卡住？请按真实感受选择；如果还不清楚，我会换一种方式讲。"
        };
  if (topicKey === "feedback-reliability")
    return english
      ? {
          hypothesis:
            "The conflicting binary-search grades are being treated as a choice of authority instead of claims checked against the rubric.",
          rationale: `Use ${strategyLabel} to compare claims against inspectable evidence.`,
          expectedSignal: "The learner separates supported, conflicting, and unresolved claims.",
          explanation: `Instead of asking “which grader should I trust?”, ask “which claim can I prove from the materials?”

**1. Turn the scoring requirement into two checks**

The answer must explain both that the search interval is halved after each comparison and that repeated halving reaches size 1 after about \`log₂ n\` comparisons.

**2. Compare those checks with the student's exact words**

The student wrote the correct final complexity, \`O(log n)\`, but said that each comparison removes only one element. Removing one element at a time describes linear shrinkage, not halving. The conclusion is present; the required reason is not.

**3. Evaluate each grader's claim**

Grader A noticed the correct conclusion but ignored the missing reasoning, so full credit is not supported. Grader B pointed to the exact mismatch between the answer and the scoring requirement, so that critique is supported.

The reusable method is: split feedback into claims, locate the relevant requirement, quote the student's evidence, then mark each claim as supported or unsupported.`,
          verificationPrompt: `Use the same method on a new answer.

**Prompt:** Explain why merge sort is \`O(n log n)\`.

**Scoring requirement:** Mention \`log n\` merge levels and \`O(n)\` work at each level.

**Student:** “The array is split in half, so the whole algorithm only does \`O(log n)\` work.”

Grader A gives full credit for mentioning halving. Grader B says the answer omits the work done at each level.

Answer three things:

- Which grader is supported?

- Which words in the student answer reveal the problem?

- What two facts must be combined to justify \`O(n log n)\`?`,
          rubric:
            "Selects grader B and cites both log n levels and O(n) work per level as the evidence needed for O(n log n).",
          outcomePrompt:
            "Does this evidence-checking method now feel clear, partly clear, or still confusing? Choose below and I can try another example if needed."
        }
      : {
          hypothesis: "当前把冲突的二分查找评分当作权威二选一，而没有逐条对照 rubric。",
          rationale: `用${strategyLabel}把每条主张与可检查证据对照。`,
          expectedSignal: "学习者能区分有支持、相互冲突和仍未确认的主张。",
          explanation: `先不要问“该信哪个评分器”，把问题换成“哪条判断能从材料中得到证明”。

**1. 把评分要求拆成两个检查点**

答案既要说明每次比较后搜索区间缩小一半，也要说明不断折半后，大约经过 \`log₂ n\` 次比较就只剩一个元素。

**2. 逐字对照学生答案**

学生写出了正确结论 \`O(log n)\`，但理由是“每次只排除一个元素”。每次只少一个属于线性缩小，不是折半。也就是说，结论出现了，支撑结论的关键理由却没有出现。

**3. 再判断两份反馈**

评分器 A 只看到了正确结论，忽略了理由缺失，所以“满分”没有充分依据。评分器 B 指出了学生答案与评分要求之间的具体矛盾，因此这条批评有证据支持。

以后可以重复这套方法：把反馈拆成主张 → 找到对应评分要求 → 引用学生原话 → 判断每条主张是否有证据。`,
          verificationPrompt: `现在用同一套方法检查一份新答案。

**题目：**解释归并排序为什么是 \`O(n log n)\`。

**评分要求：**指出有 \`log n\` 层合并，并说明每一层做 \`O(n)\` 工作。

**学生答案：**“数组每次折半，所以整个算法只做 \`O(log n)\` 工作。”

评分器 A 因为答案提到了折半而给满分；评分器 B 认为答案漏掉了每层的工作量。

请回答三点：

- 哪份反馈有证据支持？

- 学生原话中的哪一部分暴露了问题？

- 要推出 \`O(n log n)\`，必须把哪两个事实结合起来？`,
          rubric: "选择评分器 B，并同时引用 log n 层与每层 O(n) 工作，说明两者共同得到 O(n log n)。",
          outcomePrompt:
            "现在这套核查方法对你来说是清楚、部分清楚，还是仍然困惑？请在下方选择，需要的话我可以再换一个例子。"
        };
  return english
    ? {
        hypothesis: "The same cache-miss misconception persists across explanations.",
        rationale: `Use ${strategyLabel} instead of repeating the previous explanation.`,
        expectedSignal: "The learner distinguishes conflict and capacity misses in a new cache layout.",
        explanation: `Let's simulate the accesses instead of memorizing definitions.

**Direct-mapped cache**

- Block 0: miss, then store it at index 0.
- Block 4: miss; it also maps to index 0, so it evicts block 0.
- Block 0 again: miss, because block 4 replaced it.
- Block 4 again: miss for the same reason.

The first visits to 0 and 4 are compulsory misses. The later misses happen only because two blocks are forced to compete for one index, so they are conflict misses.

**2-way cache with the same four-line capacity**

- Block 0 and block 4 still map to the same set, but the set has two ways.
- Both blocks can stay at the same time, so the last two accesses hit.

The cache did not become larger; only the placement rule became less restrictive. A useful test is: if a fully associative cache with the same capacity would keep the block, the extra miss was caused by conflict. If even a fully associative cache cannot keep it because there are too many distinct blocks, it is a capacity miss.`,
        verificationPrompt: `Now apply that test to a new trace.

A cold, fully associative cache has four lines, uses LRU, and receives \`0, 1, 2, 3, 4, 0\`.

- What is stored after the access to block 4?

- Why is block 0 absent at the final access?

- Is that final miss a conflict miss or a capacity miss?

- Could higher associativity remove it without adding cache lines?`,
        rubric:
          "Classifies the final access as a capacity miss; notes that five distinct blocks exceed four lines; says associativity alone cannot remove it.",
        outcomePrompt:
          "Does the conflict-versus-capacity distinction now feel clear, partly clear, or still confusing? Choose below and I can use another trace if needed."
      }
    : {
        hypothesis: "同一个 cache miss 概念误解在多次解释后仍持续出现。",
        rationale: `改用${strategyLabel}，不重复上一种解释。`,
        expectedSignal: "学习者能在新的 cache 布局中区分 conflict miss 与 capacity miss。",
        explanation: `先不要背定义，我们直接模拟这四次访问。

**Direct-mapped cache**

- 访问 block 0：miss，把它放进 index 0。
- 访问 block 4：miss；它也只能放进 index 0，所以会挤掉 block 0。
- 再访问 block 0：miss，因为它刚被 block 4 挤掉。
- 再访问 block 4：同理还是 miss。

第一次访问 0 和 4 属于 compulsory miss。后两次本来有容量保存，却因为两个 block 被迫竞争同一个 index 而 miss，所以属于 conflict miss。

**总容量相同的 2-way cache**

- Block 0 和 4 仍然进入同一个 set，但这个 set 有两个 way。
- 两个 block 可以同时留下，因此后两次访问都命中。

Cache 并没有变大，改变的是放置限制。可以用一个判断方法区分两类 miss：如果同容量的 fully associative cache 能保留这个 block，额外 miss 来自冲突；如果 fully associative 也因为不同 block 太多而放不下，那就是 capacity miss。`,
        verificationPrompt: `现在把这个判断方法用到一条新序列上。

一个冷启动、fully associative、4 条 line、使用 LRU 的 cache 收到 \`0, 1, 2, 3, 4, 0\`。

- 访问 block 4 后，cache 里留下了哪些 block？

- 最后访问 block 0 时，它为什么已经不在 cache 中？

- 最后这次属于 conflict miss 还是 capacity miss？

- 不增加 cache line，只提高关联度能消除它吗？`,
        rubric: "把最后一次访问判断为 capacity miss；指出 5 个不同 block 超过 4 条 line；说明只提高关联度无法消除。",
        outcomePrompt:
          "现在 conflict miss 和 capacity miss 的区别对你来说是清楚、部分清楚，还是仍然困惑？请在下方选择，需要的话我可以再换一条访问序列。"
      };
}

interface DemoAssessment {
  verdict: LearningOutcome;
  confidence: number;
  feedback: string;
}

interface DemoConcept {
  zh: string;
  en: string;
  patterns: RegExp[];
}

function evaluateDemoAnswer(topicKey: string | null, answer: string, locale: "zh" | "en"): DemoAssessment {
  const normalized = answer.trim().toLocaleLowerCase();
  const concepts = demoConcepts(topicKey);
  const matched = concepts.filter((concept) => concept.patterns.some((pattern) => pattern.test(normalized)));
  const missing = concepts.filter((concept) => !matched.includes(concept));
  const verdict: LearningOutcome =
    matched.length === concepts.length ? "resolved" : matched.length > 0 ? "partial" : "unresolved";
  const label = (concept: DemoConcept) => (locale === "en" ? concept.en : concept.zh);
  if (locale === "en") {
    if (verdict === "resolved")
      return {
        verdict,
        confidence: 0.9,
        feedback: `You connected all of the important ideas: ${matched.map(label).join(", ")}. That reasoning is enough to solve this check.`
      };
    if (verdict === "partial")
      return {
        verdict,
        confidence: 0.78,
        feedback: `You are on the right track with ${matched.map(label).join(", ")}. One connection is still missing: ${missing.map(label).join(", ")}.`
      };
    return {
      verdict,
      confidence: 0.72,
      feedback: `The answer has not yet connected these ideas: ${missing.map(label).join(", ")}. That is okay—we can slow down and work through them another way.`
    };
  }
  if (verdict === "resolved")
    return {
      verdict,
      confidence: 0.9,
      feedback: `你已经把几个关键点连起来了：${matched.map(label).join("、")}。这套推理足以完成这次检查。`
    };
  if (verdict === "partial")
    return {
      verdict,
      confidence: 0.78,
      feedback: `你的方向是对的，已经说明了${matched.map(label).join("、")}。还需要补上这一层联系：${missing.map(label).join("、")}。`
    };
  return {
    verdict,
    confidence: 0.72,
    feedback: `这次回答还没有把这些关键点连起来：${missing.map(label).join("、")}。没关系，我们可以放慢一点，换一种方式继续。`
  };
}

function demoConcepts(topicKey: string | null): DemoConcept[] {
  if (topicKey === "programming-plans")
    return [
      {
        zh: "空列表返回 [] 的出口",
        en: "the empty-list base case returning []",
        patterns: [/空(?:列表|数组)/, /empty\s+(?:list|array)/, /return\s*\[\s*\]/, /返回\s*\[\s*\]/]
      },
      {
        zh: "first/rest 的递归缩小",
        en: "recursive reduction through first and rest",
        patterns: [
          /first.{0,18}rest|rest.{0,18}first/,
          /首(?:项|个).{0,18}剩余|剩余.{0,18}首(?:项|个)/,
          /items\s*\[\s*1\s*:\s*\]/
        ]
      },
      {
        zh: "两边展平结果的拼接",
        en: "concatenating both flattened results",
        patterns: [/拼接|合并|连接/, /concat|combin|append/, /flatten\s*\([^)]*\)\s*\+/]
      }
    ];
  if (topicKey === "feedback-reliability")
    return [
      { zh: "评分器 B 的结论", en: "grader B's conclusion", patterns: [/评分器\s*b|反馈\s*b/, /grader\s*b/] },
      {
        zh: "log n 层",
        en: "log n merge levels",
        patterns: [
          /log\s*(?:₂|2)?\s*n.{0,16}层|层.{0,16}log\s*(?:₂|2)?\s*n/,
          /log\s*(?:₂|2)?\s*n.{0,16}levels?|levels?.{0,16}log\s*(?:₂|2)?\s*n/
        ]
      },
      {
        zh: "每层 O(n) 工作",
        en: "O(n) work at each level",
        patterns: [
          /每(?:一)?层.{0,18}(?:o\s*\(\s*n\s*\)|线性|n\s*(?:次|项|个))/,
          /(?:o\s*\(\s*n\s*\)|线性).{0,18}每(?:一)?层/,
          /each\s+level.{0,18}(?:o\s*\(\s*n\s*\)|linear|n\s+work)/,
          /(?:o\s*\(\s*n\s*\)|linear).{0,18}each\s+level/
        ]
      }
    ];
  return [
    {
      zh: "capacity miss 分类",
      en: "the capacity-miss classification",
      patterns: [/capacity\s+miss|容量(?:不命中|缺失|未命中|miss)/]
    },
    {
      zh: "5 个 block 超过 4 条 line",
      en: "five blocks exceeding four lines",
      patterns: [/(?:5|五).{0,40}(?:4|四)|(?:4|四).{0,40}(?:5|五)/, /five.{0,40}four|four.{0,40}five/]
    },
    {
      zh: "只提高关联度不能消除",
      en: "associativity alone cannot remove the miss",
      patterns: [
        /(?:不能|不会|无法).{0,20}(?:关联度|associativ)|(?:关联度|associativ).{0,20}(?:不能|不会|无法)/,
        /\b(?:no|cannot|won't)\b/
      ]
    }
  ];
}

function englishStrategy(strategy?: LearningInterventionStrategy): string {
  return (strategy ?? "contrastive_example").replaceAll("_", " ");
}

export function chineseStrategy(strategy?: LearningInterventionStrategy): string {
  const labels: Record<LearningInterventionStrategy, string> = {
    socratic_question: "苏格拉底式追问",
    conceptual_hint: "概念提示",
    contrastive_example: "对比例子",
    worked_example: "完整示例",
    analogical_example: "类比例子",
    direct_explanation: "直接解释",
    evidence_check: "证据核查",
    abstain_escalate: "暂缓并升级"
  };
  return labels[strategy ?? "contrastive_example"];
}
