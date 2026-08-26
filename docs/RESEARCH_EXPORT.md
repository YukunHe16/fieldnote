# 研究数据导出 Codebook / Research Export Codebook

Fieldnote 的学习模式把一次性 LLM 反馈改造成可测量的连续干预单元（educational on-call）。本文档说明
`GET /api/learning/export` 导出的匿名化 JSON 的每个字段，供研究者阅读或写分析脚本时对照。

- 入口：学习面板 → **指标** 页签 →（开启研究模式后）**导出研究数据**；或直接
  `curl "http://127.0.0.1:8787/api/learning/export?includeMessages=true" -o export.json`。
- 隐私：数据从不离开本机；导出时所有字符串都会经过模式脱敏（邮箱、电话、密钥、长数字串等，见
  `apps/server/src/redact.ts`），命中敏感模式的整段文本会被整体替换。**分享前请自行复查一遍文件。**
- `includeMessages=true` 时附带学习会话所属对话的全部消息正文（同样脱敏），用于对话层面的分析。
- `?participantId=<id>` 只导出该参与者的切片（各表按自身 `participantId` 列或 incident/session 血缘过滤，切片内部关联自洽）；缺省仍导出全库。
- **浏览版**：`GET /api/learning/export/html`（同样支持 `?participantId=`）把同一份脱敏数据渲染成一页可读、可筛、可看图的 HTML（指标页有入口链接）；机器分析仍以 JSON 为准。
  - 中英双语，右上角切换，选择记在本机浏览器里；页面里的**学习者原文不翻译**，只切界面语言。
  - 默认按**回路**（incident）看：一条工单的诊断、几轮讲法、为它起草的每一道题（含被门拦下的）、学习者自己的判定、之后有没有回访，画成一条"脊线"——线上方是轮次，线下方每根竖条是一份草稿（高度＝查重分，空心＝被拒，字母是拦它的门），虚线是 0.6 硬拒线。「怎么读这条线」折叠块里有图例。
  - 顶部六张图随筛选实时重算：结果×条件、收敛轮次、草稿死在哪道门、查重分分布（画出 0.6 线）、讲法×结果、颜色图例。
  - 筛选：参与者 / 数据集 / 条件 / 困难类型 / 结果 + 全文搜索（目标、假设、题面、理由、评判标准）＋排序；「原始表」切换回十张表，同一套筛选照样生效。列表分页显示，按钮会写明还有多少条没显示。
  - 实现：整页自包含（无外部字体/脚本），数据以 JSON island 注入（`<`/`>`/`&` 转义），读取端一律走 `textContent`——学习者写的字永远不会变成标记。
- **单次学习报告**：`GET /api/learning/incidents/<id>/report.html`（加 `?download=true` 直接存文件）。学习者一确认结果就可用，是这一次回路自己的一页：卡在哪 → 试了哪些讲法 → 为你出的题（含被拒草稿与拦它的门）→ 检查题 → **系统的提议 vs 你的决定** → 接下来的回访。同样中英双语（服务端同时渲染两份，靠 CSS 切换，打印和禁用脚本时都正常），脱敏口径与研究导出一致。学习面板里回路一收尾就出现「本次学习报告」入口。

## 参与者（participantId）

`participants` 是"谁在学"的轴，与 `profileId`（Agent 配置档位）**正交**。对话在创建时归属当前参与者，
学习 session 从对话继承，经验/讲法/策略修订/复习任务/练习题记在写入时反规范化盖章。策略统计、讲法
offer、复习与指标全部按参与者隔离——A 的经验不会调 B 的教学。历史数据（加列前）全部属于
`'default'` 参与者（本机所有者）；非默认参与者的对话不进通用记忆抽取与能力自进化。飞书渠道恒为
`'default'`。分析时注意：`'default'` 混有加列前的全部历史，把它当"研究前数据 + 机主"读，不要当作
一名受试者。

## 研究条件（condition）

每个 `session` 带一个研究条件，是对照实验的分组变量：

| 值 | 含义 |
| --- | --- |
| `on-call` | 自适应回路：每个 incident 最多 3 轮干预，未解决时换策略，3 轮用尽升级（escalated） |
| `one-shot` | 一次性反馈基线：每个 incident 只允许 1 轮干预；未解决直接终态，不换策略、不升级 |
| `multi-turn` | 持续对话基线：与 on-call 相同的 3 轮预算，但无策略推荐/强制换招/升级——把回路结构从轮数中隔离出来 |

宿主在存储层强制这些边界（不是提示词约定）：one-shot 会拒绝第二次干预写入，multi-turn 会拒绝升级。

条件可以手动选择，也可以由服务端**随机分配**（研究模式下选 "随机分配"，或在 study 配置里开启
`randomize`——后者只在研究模式开启时生效）。随机分配采用 **permuted-block**：k 个臂时，每连续
k 次抽取恰好覆盖每个臂一次（按块 Fisher–Yates 洗牌），小样本不会偏斜。被分配的会话在导出里带
`conditionAssignment: { seed, index, conditions }`——臂列表是记录的一部分，因为抽取结果依赖它；
仅凭这三项即可离线复核任意一次分配（复核算法见 `apps/server/src/learning-study.ts` 的
`drawStudyCondition` 文档注释）。种子一经更换即永久退役（`usedSeeds`），不可复用。手动选择的
会话该字段为 `null`。

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
| `participantId` | 参与者（见上节；experiences/strategyVariants/policyRevisions/reviewTasks/practiceItems 同名列同义） |
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
| `practiceItemId` | 所用练习题记（见 practiceItems）；on-call agent 会话由宿主店面强制，prose 回退或不受强制的会话为 null |

### practiceItems

回路内出题的完整台账——**所有**草稿尝试（通过与被拒）都入库，质检器的行为本身可审计：

| 字段 | 说明 |
| --- | --- |
| `incidentId` / `round` | 归属 incident 与干预轮次（题记按轮绑定，验证时轮次必须仍匹配） |
| `source` | `tutor`（正常回路）/ `review`（复习回访 incident 的题记——按 incident 归类，回访第 2、3 轮在后续 run 里起草的草稿同样计入） |
| `status` | `approved` 通过待用 · `rejected` 被拒 · `consumed` 已用于验证 · `expired` 作废（该轮已有验证落地、轮次推进或 incident 关闭；学习者被新话题打断的回路可能遗留 approved） |
| `taskText` / `targetHypothesis` / `expectedAnswerSketch` / `difficulty` / `method` | 草稿本体：题面、要区分的误解假设、预期答案要点、难度 1–5、验证方法 |
| `gate` | 拦下它的门：`programmatic` / `novelty` / `evaluator`；通过为 `none`。**回退口径**：解锁 prose 回退的两次拒绝只计 `novelty`/`evaluator`（实质分歧），`programmatic`（形式错误）不计 |
| `evaluatorVerdict` | LLM Evaluator 的原始 verdict（checks + reasons）；未走到该级或出错时为 null / `status:"error"` |
| `noveltyScore` | 与本 session 语料（**已通过/已使用**题记 + 验证题面 + 目标——被拒草稿不入语料）的最高 Jaccard 相似度，>0.6 硬拒 |

消费的题面与 method 由宿主原样落库进 `verifications`，因此 `practiceItemId` 连接两表时 `taskText`=`prompt`、两侧 `method` 恒等。

**校准协议**：`scripts/practice-item-calibration.mjs export` 从本导出生成标注表（CSV，空白人工列，
`--sample N --seed S` 可复现抽样，`--dataset live,eval` 按数据集过滤——正式协议只标 live/eval，demo 是夹具噪声；
表内附 `datasetKind`/`condition` 两列供标注者辨认样本归属）；人工填完后 `report --labels <csv> --labeler <who>` 输出
evaluator-与-人工一致率报告（按 checks 维度的 fail-精确率/召回率 + 分歧分型）到
`data/eval-runs/practice-calibration.md`。报告只讲质量审查一致率，不是学习效果证据；
自标注版仅为协议烟测，标注者身份写在报告头。

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

### reviewTasks

间隔复习任务：`id` / `incidentId` / `sessionId` / `conversationId` / `round` / `dueAt` / `status` / `firedRunId`。

### watchdogEvents

看门狗台账：`id` / `sessionId` / `incidentId` / `signature`（`status:干预数:验证数`）/ `action`
（`nudged` 提醒已发 · `gave_up` 提醒后仍停摆）/ `runId`（提醒消息的 run）/ `createdAt`。
会话健康指标全部可由本表复算。

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
- **会话健康（sessions）**：以**会话**为分母的可靠性块（difficultyType 过滤下为 null，因为会话没有难度类型）。
  分母排除 suggested/dismissed 与 deterministic 会话。`neverOpened` = ≥3 个完成回合且从未开 incident；
  `stalledMidLoop` = 看门狗提醒后仍无进展（台账 `gave_up`）；`errored` = 会话期间存在失败 run；
  `unhealthy` = 命中任一类别的**去重**会话数（三类可重叠，比率用它算）；`recoveredAfterNudge` =
  提醒后 incident 发生真实回路进展（新干预/新验证/新判定/确认）——**放弃关闭不算恢复**。
  全部可由导出的 `watchdogEvents` 台账离线复算。

## 引用本数据时的边界

导出的一切（包括评测运行的结果）都来自**合成案例或模拟学习者**，除非你自己招募了真实学习者。
对外表述请使用 "simulated-learner offline evaluation / synthetic cases"，不要表述为学生学习效果。
