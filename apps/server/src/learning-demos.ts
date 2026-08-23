import type { DemoLearningExperienceSeed, LearningDifficultyType } from "./learning-store.js";

export interface LearningDemoScenario {
  id: "planning-gap" | "uncertain-feedback" | "persistent-misconception";
  title: string;
  titleEn: string;
  description: string;
  descriptionEn: string;
  preview: string;
  previewEn: string;
  loop: string;
  loopEn: string;
  goal: string;
  goalEn: string;
  topicKey: string;
  difficultyType: LearningDifficultyType;
  initialPrompt: string;
  initialPromptEn: string;
  seeds: DemoLearningExperienceSeed[];
}

export const LEARNING_DEMO_SCENARIOS: readonly LearningDemoScenario[] = [
  {
    id: "planning-gap",
    title: "递归 flatten：先补计划，再补代码",
    titleEn: "Recursive flatten: plan before patching",
    description: "阅读一段会在空列表崩溃的真实代码和失败测试，先写出出口、递归缩小与结果组合规则。",
    descriptionEn:
      "Inspect concrete code that crashes on an empty list, then state its base case, recursive reduction, and combination rule.",
    preview: "flatten([]) → IndexError\nflatten([1, [2, 3]]) → 递归末尾崩溃",
    previewEn: "flatten([]) → IndexError\nflatten([1, [2, 3]]) → crashes at the recursive tail",
    loop: "计划缺口 → 对比干预 → 对新输入作出预测",
    loopEn: "planning gap → contrastive intervention → predict a new input",
    goal: "为递归 flatten 写出可验证的出口、缩小和组合计划",
    goalEn: "Form a testable base-case, reduction, and combination plan for recursive flatten",
    topicKey: "programming-plans",
    difficultyType: "planning_gap",
    initialPrompt: `我在做一道递归练习，题目和当前代码如下。

任务：修复一个递归 flatten，使它能把任意嵌套整数列表展平成一维列表。

\`\`\`python
def flatten(items):
    first = items[0]
    rest = items[1:]
    if isinstance(first, list):
        return flatten(first) + flatten(rest)
    return [first] + flatten(rest)
\`\`\`

观察结果：
- \`flatten([])\` 立即触发 \`IndexError\`；
- \`flatten([1, [2, 3]])\` 预期得到 \`[1, 2, 3]\`，但递归处理到空的 rest 时仍会崩溃。

我现在的想法是在每个 \`items[0]\` 外面加异常处理，但还没有写清递归计划。请先不要直接给最终代码：判断我缺少哪一层计划，并引导我明确出口条件、子问题如何缩小以及结果如何组合。`,
    initialPromptEn: `I am working through a recursion exercise. Here is the full prompt and my current code.

Task: repair a recursive flatten function so it can flatten any nested list of integers.

\`\`\`python
def flatten(items):
    first = items[0]
    rest = items[1:]
    if isinstance(first, list):
        return flatten(first) + flatten(rest)
    return [first] + flatten(rest)
\`\`\`

Observed behavior:
- \`flatten([])\` immediately raises \`IndexError\`.
- \`flatten([1, [2, 3]])\` should return \`[1, 2, 3]\`, but still crashes when recursion reaches an empty rest.

My current idea is to wrap every \`items[0]\` access in exception handling, but I have not stated a recursive plan. Do not give me the final code yet. Diagnose the missing planning layer and help me identify the base case, how the subproblem shrinks, and how results combine.`,
    seeds: [
      { strategy: "contrastive_example", outcome: "resolved", count: 5 },
      { strategy: "direct_explanation", outcome: "unresolved", count: 1 }
    ]
  },
  {
    id: "uncertain-feedback",
    title: "二分查找：核验两份冲突评分",
    titleEn: "Binary search: verify conflicting graders",
    description: "对照原题、学生答案和 rubric，判断“满分”与“理由错误”两份自动反馈各自有没有证据。",
    descriptionEn:
      "Use the prompt, student answer, and rubric to decide whether a full-credit verdict or a reasoning-error critique is supported.",
    preview: "学生：每次排除一个元素，所以是 O(log n)\n评分器 A：满分 · 评分器 B：推理不成立",
    previewEn:
      "Student: removing one element each time gives O(log n)\nGrader A: full credit · Grader B: invalid reasoning",
    loop: "反馈冲突 → 证据核查 → 用第二份评分案例验证",
    loopEn: "feedback conflict → evidence check → verify on a second grading case",
    goal: "根据题目、答案和 rubric 核验自动反馈，而不是选择权威",
    goalEn: "Verify automated feedback against the prompt, response, and rubric instead of choosing an authority",
    topicKey: "feedback-reliability",
    difficultyType: "feedback_uncertainty",
    initialPrompt: `我在核对一道算法题的自动评分，下面是完整材料。

原题：解释为什么对有序数组进行二分查找的时间复杂度是 \`O(log n)\`。

评分 rubric：答案必须说明每次比较后搜索区间至少缩小一半，并把“反复折半”与至多 \`log₂ n\` 次比较联系起来。

学生答案：二分查找每次比较后排除一个不可能的元素，所以最多比较 \`log₂ n\` 次，因此是 \`O(log n)\`。

自动评分器 A：结论和复杂度都正确，给满分。

自动评分器 B：结论虽然写对，但“每次只排除一个元素”对应线性缩小，不能推出 \`O(log n)\`；理由没有满足 rubric。

我不知道应该信谁。请不要根据评分器身份做二选一，而要教我怎样把每条反馈与题目、学生答案和 rubric 中可检查的证据对齐。`,
    initialPromptEn: `I am reviewing automated feedback on an algorithms answer. Here is the complete case.

Prompt: Explain why binary search on a sorted array has time complexity \`O(log n)\`.

Rubric: The response must state that every comparison reduces the search interval by at least half and connect repeated halving to at most \`log₂ n\` comparisons.

Student response: Binary search removes one impossible element after every comparison, so it needs at most \`log₂ n\` comparisons and is therefore \`O(log n)\`.

Automated grader A: The conclusion and complexity are correct; award full credit.

Automated grader B: Although the conclusion is written correctly, removing only one element is linear shrinkage and cannot justify \`O(log n)\`; the reasoning does not satisfy the rubric.

I do not know which grader to trust. Do not choose based on authority. Teach me to align each claim with inspectable evidence in the prompt, response, and rubric.`,
    seeds: [
      { strategy: "evidence_check", outcome: "resolved", count: 5 },
      { strategy: "direct_explanation", outcome: "partial", count: 1 }
    ]
  },
  {
    id: "persistent-misconception",
    title: "Cache 访问序列：区分 conflict 与 capacity miss",
    titleEn: "Cache trace: distinguish conflict and capacity misses",
    description: "比较两个总容量相同、关联度不同的 cache，并在第二条具体访问序列上验证概念迁移。",
    descriptionEn:
      "Compare equal-capacity caches with different associativity, then transfer the distinction to a second concrete trace.",
    preview: "同为 4-line cache：direct-mapped vs 2-way\n冷启动访问：0, 4, 0, 4",
    previewEn: "Same 4-line capacity: direct-mapped vs 2-way\nCold-start trace: 0, 4, 0, 4",
    loop: "持续误解 → 更换讲法 → 用新访问序列迁移验证",
    loopEn: "persistent misconception → switch explanation → transfer on a new trace",
    goal: "根据具体 cache 配置和访问序列区分 conflict miss 与 capacity miss",
    goalEn: "Distinguish conflict and capacity misses from concrete cache configurations and traces",
    topicKey: "computer-architecture-cache",
    difficultyType: "conceptual_misconception",
    initialPrompt: `我在学习 cache miss，下面是两套具体配置和我的当前理解。

Cache A：4 条 cache line，direct-mapped，block \`b\` 映射到 \`b mod 4\`。

Cache B：总容量同样是 4 条 cache line，但为 2-way set associative（2 个 set × 每组 2 条），使用 LRU。

两者都从冷启动开始，访问 block 序列：\`0, 4, 0, 4\`。

我的理解是：Cache B 后两次访问命中，是因为“2-way 让 cache 容量变大了”；所以只要继续增大 cache，就能消除所有 conflict miss。之前的定义式解释没有让我真正分清 conflict miss 与 capacity miss。

请用一种不同的方式纠正这个理解，明确比较两种配置中的映射与驱逐，并在最后用另一条具体访问序列检查我是否能迁移。`,
    initialPromptEn: `I am learning about cache misses. Here are two concrete configurations and my current understanding.

Cache A: four cache lines, direct-mapped, with block \`b\` mapped to \`b mod 4\`.

Cache B: the same total capacity of four cache lines, but 2-way set associative (two sets × two lines per set) with LRU replacement.

Both start cold and receive the block trace \`0, 4, 0, 4\`.

My current belief is that Cache B hits on the final two accesses because “2-way makes the cache larger,” so making a cache larger should eliminate every conflict miss. Earlier definition-based explanations did not help me distinguish conflict misses from capacity misses.

Use a different teaching approach. Compare the mapping and eviction behavior in the two configurations, then check whether I can transfer the distinction to another concrete trace.`,
    seeds: [
      { strategy: "contrastive_example", outcome: "resolved", count: 5 },
      { strategy: "direct_explanation", outcome: "unresolved", count: 1 }
    ]
  }
] as const;

export function getLearningDemoScenario(id: string): LearningDemoScenario | null {
  return LEARNING_DEMO_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

export function learningDemoText(scenario: LearningDemoScenario, locale: "zh" | "en") {
  return locale === "en"
    ? {
        title: scenario.titleEn,
        description: scenario.descriptionEn,
        preview: scenario.previewEn,
        loop: scenario.loopEn,
        goal: scenario.goalEn,
        initialPrompt: scenario.initialPromptEn
      }
    : {
        title: scenario.title,
        description: scenario.description,
        preview: scenario.preview,
        loop: scenario.loop,
        goal: scenario.goal,
        initialPrompt: scenario.initialPrompt
      };
}
