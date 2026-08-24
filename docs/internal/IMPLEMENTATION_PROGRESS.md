# Adaptive Learning Loop + 可信专家协作实施进度

## 基线

- 起始基线：`822c1bd` (`fix: align memory evolution replay and product semantics`)
- 总体状态：已完成
- 完成度：`13 / 13` milestones
- 专题规范：
  - [Adaptive Learning Conversation Loop](./ADAPTIVE_LEARNING_LOOP_SPEC.md)
  - [专家协作功能说明与改造计划](./专家协作改造计划.md)

状态只由主代理根据已复核的代码、测试和提交更新。Subagent 可以执行已确定的有界任务并报告证据，但不能自行修改架构决策或宣布阶段完成。

## Shared Foundation

| ID | 状态 | 工作 | 依赖 | 验收与证据 | Commit |
| --- | --- | --- | --- | --- | --- |
| F0 | completed | 建立 baseline、正式 Spec、总进度文档并忽略运行数据 | - | baseline commit 已建立；文档与 `.gitignore` 已补齐 | `f33f0be` |
| F1 | completed | 删除伪 Mailbox 的 Runtime/API/Web/飞书语义；旧表停读写 | F0 | `pnpm typecheck`；server 174 tests；web 43 tests；旧表仅保留兼容 schema | `a3a36ec` |
| F2 | completed | InputFileManifest、P0 校验、supplement conversation scope | F0 | 宿主 Manifest、`list_input_files`、图片路径、Run 前校验与实际消息绑定；21 focused tests；server typecheck | `d3e9d73` |
| F3 | completed | 历史文件发现、分支复制、Replay Manifest、学习 Replay 隔离 | F2,L1 | 新对话分支复制并重建附件；Replay校验/重建Manifest；学习上下文冻结且dataset=replay；26 focused tests | `bed9bb7` |

## Trusted Collaboration

| ID | 状态 | 工作 | 依赖 | 验收与证据 | Commit |
| --- | --- | --- | --- | --- | --- |
| C1 | completed | Collaboration DTO、表、Store 和生命周期测试 | F0 | 任务/交接状态机、同 run 校验、结构化结果、重启读取；4 tests；server typecheck | `5e0c14c` |
| C2 | completed | 委派状态、结构化结果、Manifest 自动注入 | F1,F2,C1 | Child Query 生命周期落库；`submit_specialist_result` 成功后提交；Manifest 自动注入；非结构化 fallback；13 focused tests | `a0f987c` |
| C3 | completed | `sourceTaskId` 真实 handoff、继承、失败和中断 | C2 | 第二次真实 Query、源结果/Manifest 继承、queued→running→终态、跨 run 拒绝；9 focused tests | `f5cda88` |
| C4 | completed | Message-bound Web 面板和飞书摘要 | C3,F3 | MessageDto trace、实时task/handoff事件、Web折叠核验面板、HTTP来源过滤、飞书摘要/冲突提示；server 28 focused tests；web 47 tests/build | `c52e5d5` |

## Adaptive Learning

| ID | 状态 | 工作 | 依赖 | 验收与证据 | Commit |
| --- | --- | --- | --- | --- | --- |
| L1 | completed | Learning DTO、表、Store、状态机和 selector | F0 | 6表、单 active incident、三轮升级、用户确认、快照、数据隔离、Beta selector、policy review/rollback；8 tests | `41120ac` |
| L2 | completed | Learning Runtime context、MCP、建议和事件 | F1,L1 | active-only MCP、宿主状态校验、API/DTO/SSE、建议 detector 与 coordinator 接线；35 focused tests；全 typecheck | `b933d6c` |
| L3 | completed | Composer 入口、建议卡、学习面板和 outcome 确认 | L2 | Composer/建议/状态pill、当前/历史/策略页签、message+panel确认、SSE刷新；45 web tests；typecheck/build | `0a6a1c7` |
| L4 | completed | Policy review/rollback、合成种子和三个 Demo | L3,F3 | 三个真实首消息 Demo、明确合成标记、demo-only 经验与 pending policy；server 14 focused tests；web 48 tests/typecheck/build | `ea21fcf` |

## Integration

| ID | 状态 | 工作 | 依赖 | 验收与证据 | Commit |
| --- | --- | --- | --- | --- | --- |
| I1 | completed | 双功能同 Run、文档收口和全量验证 | C4,L4 | 同 Run 隔离、跨轮 outcome、Run supersession、补充附件 Manifest、策略 preview/baseline、双语生产 UI；server 193 tests、web 49 tests、typecheck/build/diff-check | `c537a9c` |

## Post-review hardening

| ID | 状态 | 工作 | 验收与证据 | Commit |
| --- | --- | --- | --- | --- |
| R1 | completed | supplement/steer 竞态、输入附件不可变、Web/飞书 20 MB 上限 | 延迟 Manifest 回归；沙箱 `denyWrite`；同路径生成文件拒绝覆盖用户输入 | `726f23e` |
| R2 | completed | superseded Run 后台抽取竞态 | 延迟 analyzer 中途分支；无旧标题、task memory 或学习建议写入 | `b714a05` |
| R3 | completed | paused learning mutation 与 rejected policy 去重 | paused 拒绝五类 Runtime 状态推进；相同 evidence 的 rejected revision 不重提 | `fab6fb6` |
| R4 | completed | Replay evidence、流式 outcome、409 冲突和三 Demo 完整学习回路 | 三场景 diagnosis→intervention→verification→system outcome→user confirmation；消息完成后才显示确认 | `0aa9003` |
| R5 | completed | 专家与学习 Runtime 服务边界 | `LearningCoordinator`；`SpecialistGateway` / `LocalClaudeSpecialistGateway` 真实接管 Child Query 启动 | `63df59a` |
| R6 | completed | 三个学习 Demo 从抽象方向改为可作答案例 | 完整代码/答案/rubric/cache 配置；按关键证据判定而非字符数；全局 Claude 下仍走确定性 Demo runtime；合成经验聚合说明、rubric 展开与宽窄屏 Browser 验收 | `a49cb7f` `86ededd` `19b2a56` `a8296ee` |
| R7 | completed | 学生教学对话与学习框架看板严格分层 | 三案例逐步示范与脚手架问题；Runtime 禁止框架词泄漏；系统 verdict/confidence 和用户确认只在看板显示；学生清单保留原始 Markdown | `1c6e333` `0e37890` `70f35a2` `f245c3c` |
| R8 | completed | 学习 verification 回答框 | 复用 AskUserQuestion 自由文本 UI；仅在 assistant verification 完成且无 active Run 时显示；提交为下一轮普通 user message；选择题保留现有 options 渲染 | `b04e6bb` |
| R9 | completed | 固定案例增加真实 Agent 执行入口 | Session executionMode 与旧数据迁移；Agent 可用性/API 拒绝降级；双入口 UI；真实 Learning MCP 全链路；Agent Demo low effort；框架工具活动只进看板 | `5f13308` `7d4f757` `dac1e82` `45677f2` |

## 决策记录

- 学习模式是会话级能力，不新增专用 Profile。
- 学习模式手动开启，系统只能建议；V1 仅 Web。
- Outcome 由系统提出、用户确认；用户结论为 final verdict。
- Demo 使用明确标注的合成种子，与 live/replay 数据隔离。
- 教学策略在学习面板独立审核，不复用 `evolved_artifacts`。
- 专家协作保留真实委派，删除伪 Mailbox；当前不接入 A2A。
- InputFileManifest 是主助手、专家、分支和 Replay 的统一输入文件真相源。
- verification 与 outcome 必须跨真实学习者回合；确认按钮绑定提出 outcome 的 assistant message。
- 首次策略候选自动建立默认 baseline，确保第一条修订也能回滚。
- 编辑/Retry 通过 `runs.superseded_at` 淘汰旧学习统计和待审策略，并中断被移出分支的活跃/排队 Run。
- 补充消息的 Manifest 会进入后续专家任务与 Replay；空 JSON POST、跨 conversation 附件和服务端声明的 4xx 不再被误报。
- 用户输入附件是只读、不可变输入；生成文件不能复用或覆盖其路径，Web 与飞书统一 20 MB 上限。
- Replay 的 frozen learning context 只提供脱敏、无 ID 的历史快照；新 incident 只能引用 Replay 当前消息 ID。
- 固定案例的 `executionMode` 显式区分 `deterministic` 与 `agent`；两者共享 `datasetKind=demo` 隔离，只有前者强制走 `LearningCoordinator`，后者必须调用真实 Agent SDK，不允许伪装或静默降级。
- 合成案例必须提供自包含材料与可检查 rubric；系统暂定结果按场景关键证据生成，不能再用回答长度代替语义检查。
- 学生对话是纯教学界面；On-call、自进化、incident、策略与正式评估元数据属于学习看板，不允许依赖正文向学生解释系统框架。
- 专家 Child Query 统一经 `SpecialistGateway`；当前本地实现为 `LocalClaudeSpecialistGateway`。

## 验证日志

| 时间 | Milestone | 命令 | 结果 |
| --- | --- | --- | --- |
| 2026-08-21 | baseline | `pnpm typecheck` / `pnpm test` / `pnpm build` | 通过；server 159 tests，web 43 tests |
| 2026-08-21 | F1 | `pnpm typecheck` / `pnpm test` / `git diff --check` | 通过；server 174 tests，web 43 tests |
| 2026-08-21 | C1 | `pnpm --filter @fieldnote/server typecheck` / `vitest collaboration-store` | 通过；4 tests |
| 2026-08-21 | F2 | `pnpm --filter @fieldnote/server typecheck` / `vitest input-file-manifest orchestrator activity-presentation` | 通过；21 tests |
| 2026-08-21 | L1 | `pnpm --filter @fieldnote/server typecheck` / `vitest learning-store` | 通过；8 tests |
| 2026-08-21 | C2 | `pnpm --filter @fieldnote/server typecheck` / `vitest managed-delegation collaboration-store input-file-manifest` | 通过；13 tests |
| 2026-08-21 | C3 | `pnpm --filter @fieldnote/server typecheck` / `vitest managed-delegation collaboration-store` | 通过；9 tests |
| 2026-08-21 | L2 | `pnpm typecheck` / `vitest learning-store learning-opportunity managed-delegation app memory-coordinator` | 通过；35 tests |
| 2026-08-21 | F3 | `pnpm --filter @fieldnote/server typecheck` / `vitest app run-replay orchestrator learning-store` | 通过；26 tests |
| 2026-08-21 | L3 | `pnpm --filter @fieldnote/web typecheck` / `test` / `build` | 通过；45 tests |
| 2026-08-21 | C4 | server typecheck + `vitest app feishu managed-delegation collaboration-store`; web typecheck/test/build | 通过；server 28 focused tests，web 47 tests |
| 2026-08-21 | L4 | `pnpm typecheck`; `vitest learning-store app`; web test/build；`git diff --check` | 通过；server 14 focused tests，web 48 tests |
| 2026-08-21 | I1 | `pnpm typecheck` / `pnpm test` / `pnpm build` / `git diff --check` | 通过；server 38 files / 193 tests，web 9 files / 49 tests |
| 2026-08-21 | I1 UI | 桌面 + 390×844 / 390×500；隔离 production demo | 三场景双语、低高度滚动、真实首消息、历史、preview、enable/rollback 通过；console 0 errors |
| 2026-08-21 | post-review | `pnpm typecheck` / `pnpm test` / `pnpm build` / `git diff --check` | 通过；server 40 files / 204 tests，web 10 files / 51 tests |
| 2026-08-21 | Browser QA | 指定 Browser；隔离 Fieldnote production/demo；390×500 | Demo 当前回路、pause/resume、跨轮 outcome、用户确认、策略 preview/enable/rollback 全部通过；console 0 errors |
| 2026-08-21 | R6 | `pnpm typecheck` / `pnpm test` / `pnpm build` / `git diff --check`；指定 Browser 1440×900 / 390×844 | 通过；server 40 files / 206 tests，web 10 files / 52 tests；三张具体案例卡、三案例首轮、递归完整确认、rubric 展开、合成经验汇总和停靠/模态布局通过 |
| 2026-08-21 | R7 | `pnpm typecheck` / `pnpm test` / `pnpm build` / `git diff --check`；指定 Browser 暗色桌面 | 通过；学生正文逐步讲解与纵向检查清单、自然 outcome 反馈、看板 system assessment/confidence、框架词隔离、console 0 errors |
| 2026-08-21 | R8 | Web typecheck/test/build；指定 Browser 暗色桌面 | 通过；AskUserQuestion 风格自由文本框、disabled/ready、提交后新 user message、下一 Run outcome、回答框自动消失、console 0 errors |
| 2026-08-21 | R9 | `pnpm typecheck` / `pnpm test` / `pnpm build` / `git diff --check`；指定 Browser 真实 Claude | 通过；server 40 files / 210 tests，web 10 files / 54 tests；真实 diagnosis→strategy→intervention→verification→answer→90% outcome→用户确认；console 0 errors |

## 已知阻塞

- 无。

## 提交纪律

- 每个 milestone 独立提交，提交前运行相关测试与 `git diff --check`。
- Shared Runtime、Orchestrator、Replay 的合并和阶段完成判定由主代理负责。
- `data/.runtime-plugins/`、`data/evolved/`、数据库和工作区运行数据不得提交。

## 里程碑收尾清单

- [ ] `pnpm typecheck` / `pnpm test` / `pnpm build` / `git diff --check` 全过，验证日志补一行。
- [ ] 若改动了对外可声称的行为（新能力、新边界、新失败模式），更新**本机私有材料的能力账本**
      （`~/Documents/fieldnote-private/FACULTY_RESEARCH_MATCH.md` §2.2）——那是"系统能做什么"的
      唯一事实源，其余材料引用它。只改这一处，然后回看该目录 ROADMAP §0 的 delta 要不要补一行。
      **不要**在多份材料里各抄一份能力描述：那正是它们上次几小时内就集体过期的原因。
- [ ] 若改动影响学习回路的行为或评测口径，标记既有评测数字为待重跑——数字必须描述当前的回路。
- [ ] 提交前复查公开仓不含任何本机私有材料里的人名（具体姓名与 grep 命令记在
      `~/Documents/fieldnote-private/` 的 ROADMAP §5，**不写进本仓库**——否则这条清单本身
      就成了泄漏点）。
