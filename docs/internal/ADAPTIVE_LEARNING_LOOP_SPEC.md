# Adaptive Learning Conversation Loop v1

## 目标

在现有聊天工作台中增加会话级学习模式。它保持对话为主界面，通过结构化的诊断、干预、验证和受控策略演进，展示可迁移到不同 computing-education 主题的 educational on-call 能力。

V1 不接入 PrairieLearn，不建设题库、课程管理或正式答题系统，不声称改善了真实学生的学习效果。

当前实现状态由 [IMPLEMENTATION_PROGRESS.md](./IMPLEMENTATION_PROGRESS.md) 统一记录。本文件保留产品与状态机规范，不作为完成度清单。

## 产品行为

- Web Composer 旁提供“学习模式”按钮；开启时填写学习目标和可选 topic。
- 支持暂停、继续和结束；普通对话不受影响。
- paused session 继续允许用户确认已经提出的 outcome，但 Runtime 不能再新增 incident、intervention、verification、system outcome 或 escalation。
- 后台只能建议开启，不能自动开启。建议要求置信度至少 `0.75`，并存在明确困惑信号或连续两个教育意图回合。
- 每个会话最多一个 learning session，每个 session 同时最多一个未结束 incident。
- 每个 incident 最多自动尝试三轮干预，仍未解决时进入 escalated。
- 服务端看门狗（60 秒 tick，无状态、按数据库重算）：live+agent 会话的 incident 该由 tutor 行动却连续两个完成回合无动作时，发一条方括号标注的相位匹配提醒；提醒后仍无进展记 `gave_up` 并沉默。等待学习者的状态与 harness 自己发起的回合都不算停摆；台账 `learning_watchdog_events` 进研究导出。
- 回路内出题（on-call 条件的 agent 会话挂载 `draft_practice_task`，replay 除外——回放工具集须与原始运行一致）：tutor 请求验证前先提交结构化题稿，同回合过三级质检——程序硬门（上限/答案泄漏，双脚本按字符权重同等）→ 新颖性硬门（对 session **已通过/已使用**题记 + 验证题面 + 目标的 Jaccard 查重，>0.6 拒；被拒草稿不入语料，否则修订重试会撞自己的废稿）→ LLM Evaluator（提示词附学习者已见文本；拒绝有效、基础设施错误 fail-open；返回后对最新语料同步复检新颖性，落库前重验回路状态）。live/eval 由店面强制 `request_learning_verification` 携带通过题记，宿主把题面与 method 原样落库、同事务消费；通过未用项随该轮验证落地/轮次推进/incident 关闭作废；同 (incident, 轮次) 2 次**实质**被拒（novelty/evaluator，程序门不计）后解锁 prose 回退。全部尝试入 `learning_practice_items`（复习回访生成的标 `source='review'`）进研究导出；基线条件不挂载。
- 参与者轴：`participants` 表 + 会话/学习六表的反规范化 `participant_id`（默认 `'default'`，升级库由列默认值完成回填）。会话创建时从 conversation 继承参与者；策略统计、讲法、策略修订、复习任务、练习题记、指标与导出全部按参与者过滤；非默认参与者与机主记忆双向隔离：抽取侧由 memory-coordinator 外科式跳过写入（标题与学习建议保留），注入侧由 orchestrator 对非默认参与者关闭 memoryEnabled/evolutionEnabled（记忆、手册、领域卡、能力工件全不进提示词，memory 工具不挂载）；evolution-store 的 SQL 镜像同步排除。面板路由（variants/policies/metrics/export 链接）按对话本人解析参与者；回放继承原对话参与者；HTTP 建 feishu 会话强制 default。复习 runner 保持全局——任务只会发进它自己的原对话，天然按人隔离。`DEFAULT_PARTICIPANT_ID` 是唯一常量来源。入口收敛：研究模式开关是全局设置，位置在 ⊞ 工作区菜单第一项（不再藏在学习面板的指标标签里）；该菜单里「记忆／手册／能力／交付货架」四个入口合并成单个「工作区」按钮——四者本来就是同一个对话框的四个标签页，菜单再列一遍只是把它撑到溢出屏幕；菜单本身也加了 max-height＋内部滚动，并且是唯一的复杂度闸门——关闭时参与者切换器、学习主题输入、研究条件选择、数据导出一律不渲染；参与者与助手两个下拉并排在顶栏且各带标签；学习主题改为 datalist 建议（`GET /api/learning/topics`，按参与者取历史 topic_key，仍允许自由输入），避免同一主题分裂成多种写法把统计切碎。学习设置浮层本身是 header / 可滚动 body / footer 三段：主行动（取消·开启）钉在底部永远可见，三个固定案例默认折叠成一行（标题＋一句话＋两个开始按钮），代码预览、回路链路与「会产生模型调用」提示收在展开区里；案例列表自己是唯一的滚动区（`flex: 1` 吃掉剩余高度、上限 13.4rem＝正好两张卡），所以浮层整体不再滚动，表单部分永远可见。两处滚动区都用同一个 `useEdgeFade` 给顶/底加渐隐遮罩（被遮住的内容是淡出而不是被切断），并且打开时强制 scrollTop=0（`overflow-anchor: none`），否则 autoFocus 会把学习目标顶出视野。复习延迟默认 +2d/+5d（研究口径）；`LEARNING_REVIEW_ROUND1/2_DELAY_MS` 环境变量仅供本地观察回访流程用（≥60s），正式研究必须不设。研究导出另有人类可读 HTML 端点 `/api/learning/export/html`（与 JSON 同一脱敏数据）：中英双语、按 incident 聚合成"回路"视图（脊线：线上轮次、线下草稿高度＝查重分、空心＝被门拦下）、六张随筛选重算的图、参与者/数据集/条件/困难类型/结果筛选＋全文搜索，以及可切回的十张原始表；数据以 JSON island 注入并全程 textContent 渲染。单次回路另有 `/api/learning/incidents/<id>/report.html`（`?download=true` 存文件），学习者确认结果后可用，突出"系统的提议 vs 学习者的决定"，面板在回路收尾时给出入口。脱敏侧：`redact.ts` 除 UUID 外还必须屏蔽 ISO 时间戳——否则 `2026-08-25` 命中电话规则，导出里每个 createdAt 都会变成 `[REDACTED_PHONE]T…`，时间维度分析全废。
- 系统依据验证证据提出 outcome，用户确认“理解了 / 部分理解 / 仍未解决”；用户结论覆盖系统结论，但两者都保存。
- 确认之后是否再开一轮，只看 incident 落到什么状态：`diagnosed` 就是“还欠一轮”，`partial` 和 `unresolved`（未到升级阈值）都会落在这里。Web 与飞书两侧的自动跟进消息必须以状态为准——曾经按 verdict 判断，结果 `partial` 确认完既不开下一轮也永不收尾，回路就停在那里，指标里也看不见（策略×结局只数已收尾的回路）。看门狗救不了这种：它要求“学习者又说了 ≥2 轮而回路没动”，而这里学习者一句话都没再说。
- verification 记录请求它的 Run / assistant message；系统 outcome 必须来自学习者回答后的后续 Run，并绑定提出 outcome 的新 assistant message。
- 学习面板包含“当前回路 / 历史 / 教学策略”三个页签。
- 学生可见对话只包含学科材料、逐步讲解、练习问题和自然反馈；incident、diagnosis、confidence、strategy、rubric、policy、synthetic experience、自进化和工具状态只能出现在学习面板或内部工具调用中。

## 状态与数据

学习数据独立于普通记忆和 `evolved_artifacts`：

- `learning_sessions`
  - status：`suggested | active | paused | completed | dismissed`
  - datasetKind：`live | demo | replay`
  - goal、topicKey、profileId
- `learning_incidents`
  - difficultyType：`planning_gap | conceptual_misconception | procedural_gap | feedback_uncertainty | prerequisite_gap | other`
  - hypothesis、confidence、severity、证据消息和关闭快照
- `learning_interventions`
  - strategy：`socratic_question | conceptual_hint | contrastive_example | worked_example | analogical_example | direct_explanation | evidence_check | abstain_escalate`
  - rationale、expectedSignal、policy revision、run/message 引用
- `learning_verifications`
  - method：`self_explanation | transfer_example | prediction | comparison | user_report`
  - prompt、rubric、系统 verdict/confidence、用户 verdict、final verdict
- `learning_experiences`
  - 只从用户确认的 verification 生成
  - demo、live、replay 严格隔离
  - 每条 experience 保存当时的 incident 快照，供无模型重跑的策略预览使用
- `learning_policy_revisions`
  - 按 profile/topic/difficulty 隔离
  - status：`pending | enabled | rejected | disabled`

删除 conversation 时级联删除学习数据。Retry 或编辑替换旧 Run 时，Run 写入 `superseded_at`，关联 incident 标记 superseded/abandoned，旧 experience 排除统计，依赖旧证据的 pending policy 自动拒绝。

## Agent 接口

Active session 才加载 `learning` MCP，并注入只读 `<learning_context>`。

工具：

- `open_learning_incident`
- `record_learning_intervention`
- `request_learning_verification`
- `propose_learning_outcome`
- `escalate_learning_incident`

宿主在 context 中提供精确的当前 user/assistant message ID，并校验状态转换、run/message 归属、验证与 outcome 的跨轮顺序和干预轮次。模型不能确认最终 outcome、启用 policy 或直接写 strategy stats；Runtime 明确禁止模型把学习框架元数据复述到学生可见正文。

## 受控策略演进

- 少于三条匹配 confirmed experience 时使用 enabled policy 的默认顺序。
- 三条及以上时使用 Beta posterior：resolved 计成功 1，partial 对成功/失败各计 0.5，unresolved 计失败 1。
- 同一 incident 已失败的策略额外降权。
- 至少五条 confirmed experience，且最佳策略与当前首选不同、posterior 优势至少 `0.10` 时生成 pending revision。
- Demo 只读取 demo experiences；Live 只读取 live experiences；Replay 不进入统计。
- Preview 在冻结 incident snapshots 上比较当前与候选策略，不重新运行模型。
- Policy 必须人工启用，支持拒绝和回滚；首次候选会自动建立同 scope 的默认策略 baseline，因此第一条修订也能回滚。

## Web 与 Demo

- Composer 显示学习模式入口、状态 pill 和建议卡。
- 对应 assistant message 与学习面板显示 outcome 确认按钮。
- Assistant 完成一条尚未回答的 verification 后，Composer 复用 `AskUserQuestion` 的自由文本渲染显示简洁回答框；提交内容必须成为新的普通 user message / Run，不能作为同一 Run 的工具返回值。带 options 的普通选择问题继续由现有 `AskUserQuestion` 选择器渲染。
- “仍未解决，换种讲法”记录 unresolved，自动提交一条真实后续消息，并进入下一种策略。
- 教学策略在学习面板独立审核，不与普通 Skill/子代理混合。
- 学习面板承载诊断假设、置信度、教学策略、内部检查标准、系统 verdict/confidence、用户确认、合成经验和策略修订；这些信息不依赖对话正文展示。
- 三个固定案例均为自包含、可直接作答的微型案例：
  1. 带失败输入的递归 `flatten` 代码，用出口、递归缩小和组合规则诊断计划缺失；
  2. 带原题、学生答案、rubric 和两份评分的反馈冲突核验；
  3. 带具体 cache 配置和访问序列的 conflict/capacity miss 迁移验证。
- 每个固定案例提供两个明确入口：
  - **稳定演示**：`executionMode=deterministic`，由 `LearningCoordinator` 确定性创建 diagnosis/intervention/verification，并按案例关键证据提出 outcome；
  - **真实 Agent**：`executionMode=agent`，由真实 Claude Agent + Learning MCP 自主创建和推进同一学习回路，结果可能变化并产生模型调用；无 Claude runtime 时入口禁用且 API 拒绝启动，不静默降级。
- 两种入口都创建 `local-operator` Web 对话并使用独立 `datasetKind=demo` 命名空间，最终 outcome 仍由用户确认；预置合成经验在 UI 中聚合说明，不冒充学习者历史。
- 两种入口都不进入普通记忆或通用能力自进化。真实 Agent 演示只为固定小题单独使用 low effort，普通学习模式及其他 Agent 任务继续使用全局配置。
- Learning MCP 活动块属于学习框架元数据，只在学习看板呈现，不在学生消息正文中显示。
- 三个案例的学生正文必须先用原题做逐步示范，再给带脚手架的迁移问题；不得用术语摘要代替教学过程，也不得把 Store 中为看板规范化的单行文本回填为学生正文。

## API 与事件

API：

- `GET/POST/PATCH /api/conversations/:id/learning-session`
- `POST /api/learning/verifications/:id/confirm`
- `GET /api/learning/policies`
- `POST /api/learning/policies/:id/review`
- `POST /api/learning/policies/:id/rollback`
- `GET /api/learning/demo-scenarios`
- `POST /api/learning/demo-scenarios/:id/start`

事件：

- `learning.suggested`
- `learning.session.updated`
- `learning.incident.updated`
- `learning.policy.updated`

`ConversationDetailDto` 增加可选 `learningSession`。普通历史列表不携带完整学习记录。

## Replay 与共享基础

- Replay 按值冻结原输入与补充、learning session、incident、policy context 与输入附件 Manifest。
- Replay conversation 使用 `datasetKind=replay`，不得产生 live experience 或 policy proposal。
- frozen learning context 在 Runtime 中是无可调用 ID 的只读历史；Replay 新 incident 的 evidence 只能引用 Replay 当前 conversation 的消息 ID。
- 学习模式与专家协作使用独立 MCP、表和事件；同一 Run 可同时启用，但专家结果不能自动成为学习 outcome。
- 输入文件统一由宿主 Manifest 校验和注入，学习证据只引用 message/run/file，不复制文件内容。

## 验收

- 学习模式关闭时现有申学、文件、记忆和自进化行为无变化。
- 三个 Demo 均能完成 diagnosis → intervention → verification → confirmation。
- unresolved 后不会重复已失败策略。
- Demo/live/replay 数据严格隔离。
- Policy proposal、preview、review、enable 和 rollback 可解释且可测试。
- `pnpm typecheck`、`pnpm test`、`pnpm build` 和 `git diff --check` 全部通过。
