# 研究数据导出 Codebook / Research Export Codebook

Fieldnote 的学习模式把一次性 LLM 反馈改造成可测量的连续干预单元（educational on-call）。本文档说明
`GET /api/learning/export` 导出的匿名化 JSON 的每个字段，供研究者阅读或写分析脚本时对照。

- 入口：学习面板 → **指标** 页签 →（开启研究模式后）**导出研究数据**；或直接
  `curl "http://127.0.0.1:8787/api/learning/export?includeMessages=true" -o export.json`。
- 隐私：数据从不离开本机；导出时所有字符串都会经过模式脱敏（邮箱、电话、密钥、长数字串等，见
  `apps/server/src/redact.ts`），命中敏感模式的整段文本会被整体替换。**分享前请自行复查一遍文件。**
- `includeMessages=true` 时附带学习会话所属对话的全部消息正文（同样脱敏），用于对话层面的分析。

## 研究条件（condition）

每个 `session` 带一个研究条件，是对照实验的分组变量：

| 值 | 含义 |
| --- | --- |
| `on-call` | 自适应回路：每个 incident 最多 3 轮干预，未解决时换策略，3 轮用尽升级（escalated） |
| `one-shot` | 一次性反馈基线：每个 incident 只允许 1 轮干预；未解决直接终态，不换策略、不升级 |

宿主在存储层强制这些边界（不是提示词约定）：one-shot 会拒绝第二次干预写入。

## 数据集（datasetKind）

| 值 | 含义 | 是否进入策略自进化 |
| --- | --- | --- |
| `live` | 真实使用 | 是（仅 on-call） |
| `demo` | 固定案例演示（含合成经验种子） | 是，但与 live 隔离 |
| `replay` | 回放重跑 | 否 |
| `eval` | 离线评测运行（`scripts/learning-eval.mjs`） | 否——评测固定默认策略顺序，保证题目间相互独立 |

## 状态机

```text
session:  suggested → active ⇄ paused → completed | dismissed
incident: diagnosed → intervening → verifying → (resolved | unresolved | escalated | abandoned)
          confirm=unresolved 且 on-call 且轮数<3 → 回到 diagnosed（换策略）
          confirm=unresolved 且 on-call 且轮数=3 → escalated
          confirm=unresolved 且 one-shot        → unresolved（终态）
          会话结束/重试替换 → abandoned / superseded
```

## 表与字段

### sessions

| 字段 | 说明 |
| --- | --- |
| `id` / `conversationId` / `profileId` | 会话、所属对话、助手档位 |
| `goal` / `topicKey` | 学习目标与主题键（主题键用于策略经验隔离与指标分组） |
| `status` | 见状态机 |
| `datasetKind` / `condition` | 见上两节 |
| `executionMode` | `agent`（真实模型）或 `deterministic`（脚本化演示协调器） |
| `suggestionReason` | 若由建议卡开启，触发原因 |

### incidents

| 字段 | 说明 |
| --- | --- |
| `difficultyType` | `planning_gap` / `conceptual_misconception` / `procedural_gap` / `feedback_uncertainty` / `prerequisite_gap` / `other` |
| `hypothesis` / `confidence` / `severity` | 诊断假设、诊断置信度 [0,1]、严重度 1–5 |
| `evidenceMessageIds` | 触发诊断的消息证据 |
| `status` / `closedAt` / `closedSnapshot` | 终态与关闭快照（含全部干预与验证的冻结副本） |
| `supersededAt` | 被编辑/重试替换的时间；非空的 incident 不进入任何统计 |

### interventions

| 字段 | 说明 |
| --- | --- |
| `strategy` | 8 类教学策略之一（socratic_question…abstain_escalate） |
| `rationale` / `expectedSignal` | 选择理由与预期学习信号 |
| `round` | 轮次（on-call ≤3；one-shot 恒为 1） |
| `policyRevisionId` | 若选择来自某条已启用策略修订 |

### verifications

| 字段 | 说明 |
| --- | --- |
| `method` | `self_explanation` / `transfer_example` / `prediction` / `comparison` / `user_report` |
| `prompt` / `rubric` | 面向学习者的验证任务与内部检查标准 |
| `systemVerdict` / `systemConfidence` | 系统在学习者作答后的判定与置信度——**校准分析的原始数据** |
| `userVerdict` / `finalVerdict` | 学习者最终确认；最终判定以学习者为准，两者都保留 |
| `requestedRunId` / `proposedRunId` | 验证请求与判定提出所在的 Run（宿主强制跨轮顺序） |

### experiences

只有 **on-call 且 live/demo** 的用户确认结果才会写入 experience——它是策略自进化（Beta 后验排序）的唯一
燃料。one-shot 与 eval 的结局刻意不写入，防止污染排序；分析这两类结果请直接用 verifications。

### policyRevisions

受控策略演进的修订记录：`orderedStrategies`（候选顺序）、`evidenceExperienceIds`（证据）、
`status`（pending/enabled/rejected/disabled）、`previousRevisionId`（回滚链）。

### strategyVariants

讲法（自发明教学方式）：`id` / `profileId` / `topicKey` / `difficultyType` /
`baseStrategy`（所细化的基础策略，八选一，集合不变）/ `title` / `instruction`（具体讲法，≤300 字）/
`origin`（仅 distilled）/ `status`（pending 待审 / trial 试用中 / enabled 转正 / rejected / retired）/
`sourceIncidentId`（蒸馏来源 incident）/ `recommendation`（promote/retire/null，宿主按后验给出的建议）/
`recommendationSummary` / `evidenceExperienceIds` / `attributedCount` / 时间戳。

**归因口径（prompt 投放核验）**：interventions 与 experiences 的 `strategyVariantId`
由宿主确定性盖章——宿主在渲染提示词时把当轮 offer（enabled 优先，否则归因数最少的
trial，平局取最老）写入投放台账（learning_variant_offers，按 incident×round），记录干预时
仅当该轮台账存在、且导师记录的策略恰为台账中的投放策略才盖章。运行中途才开出的事件，
其首轮提示词从未包含讲法，故不盖章、计入对照。模型无自报参数。转正建议要求 ≥5 条归因
且至少 1 条同 scope 对照。注意这是观察性数据：无变体的基础策略行会过采样变体出现之前的
时期，转正的因果检查是人审门，不是后验差值本身。讲法只在 live on-call 会话中被 offer 与
蒸馏；eval 保持序无关、one-shot 保持纯基线。

### handoffs

升级事件的结构化交接报告（宿主从上述表确定性渲染，不调模型）：`incidentId` / `goal` /
`topicKey` / `difficultyType` / `hypothesis` / `confidence` / `severity` /
`escalationReason`（工具升级时的原因，三轮自动升级为 null）/ `attempts[]`
（round / strategy / rationale / expectedSignal / verificationPrompt / outcome）/
`stillOpen[]`（未通过验证的 rubric，即学习者尚未达到的掌握标准）/
`suggestedNextStrategies[]`（按当时策略序排列的未尝试策略，供接手的人类导师起步）/ `closedAt`。
两条升级路径（escalate 工具、三轮耗尽自动升级）写入同构的 closed snapshot。

### messages（可选）

`includeMessages=true` 时附带：`id` / `conversationId` / `runId` / `role` / `content` / `createdAt`。

## 指标口径（GET /api/learning/metrics）

- **已关闭问题（incidents）**：状态为 resolved/unresolved/escalated 且未被替换；abandoned 不计入。
- **结局（outcomes）**：取该 incident 最后一次有最终判定的 verification 的 `finalVerdict`；
  升级且无确认判定时计为 unresolved。
- **无升级解决率（resolutionWithoutEscalationRate）**：未升级且结局非 unresolved 的比例——
  与 SRE on-call 的 automation coverage 同构。
- **校准（calibration）**：按 `systemConfidence` 分桶（<0.6、0.6–0.7、0.7–0.8、0.8–0.9、≥0.9），
  统计 `systemVerdict === finalVerdict` 的一致率。校准按验证层统计，不要求 incident 已关闭。

## 引用本数据时的边界

导出的一切（包括评测运行的结果）都来自**合成案例或模拟学习者**，除非你自己招募了真实学习者。
对外表述请使用 "simulated-learner offline evaluation / synthetic cases"，不要表述为学生学习效果。
