# 更新日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构与[语义化版本](https://semver.org/lang/zh-CN/)。0.x 阶段公开接口仍可能变化。

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Public interfaces may still change during 0.x.

## 0.1.0 — 2026-08-23

首个公开版本。Fieldnote 是一个本地优先的 Claude Agent 教育工作台，全部运行在你自己的机器上。

Initial public release. Fieldnote is a local-first Claude Agent workbench for education that runs entirely on your own machine.

**新增 / Added**

- **申学助手** — 面向美国、加拿大、香港和新加坡硕士/MPhil/PhD 申请：院校与项目调研、选校策略、导师匹配、CV/SOP/PS/Research Statement 与套磁面试准备；申学看板管理申请周期、目标项目、材料、任务与截止日期，结论可回溯到官方来源；复杂文书由受控专家真实协作完成。
  *Graduate-admissions assistant: program research, school-list strategy, advisor matching, application-document drafting, and a tracker board for cycles, programs, materials, tasks, and deadlines — with governed specialist collaboration and traceable official sources.*
- **对话式学习模式** — 目标 → 定位困难 → 诊断 → 教学干预 → 验证 → 由学习者确认结果的闭环；6 类困难、8 种教学策略、5 种验证方式，每个 incident 最多三轮干预；教学内容与内部诊断信息严格分离。
  *Adaptive learning conversation mode: a diagnose-teach-verify loop with learner-confirmed outcomes, capped at three intervention rounds per incident, keeping internal diagnostics out of the learner-facing chat.*
- **受控自进化与跨对话记忆** — 教学策略按 Beta posterior 从已确认经验中演进，达到阈值才生成待审修订并支持启用前后 Replay 预览；通用能力自进化产出需人工审核的 Skill / 子代理候选；本地 SQLite 记忆层管理个人资料、偏好、目标与项目，并定期精炼。
  *Governed self-evolution and cross-conversation memory: Beta-posterior teaching-policy revisions under human review with before/after Replay preview, human-reviewed Skill/subagent candidates, and a local SQLite memory layer with periodic curation.*
- **飞书渠道与定时报告** — 本地长连接接入飞书机器人，CardKit 流式卡片展示 Thinking、Skill 与专家活动；每周申学周报与每日计划模板，默认关闭，可投递到 Web 或飞书。
  *Feishu (Lark) bot channel over a local long connection with streaming CardKit replies, plus weekly and daily scheduled admissions reports (disabled by default).*
- **Run Replay、工作区沙箱、文档技能与临时对话** — 冻结本地输入边界的可复核重放；每段对话独立的可写工作区；Markdown 导出为真实 DOCX/PDF；不写入记忆、结束即清理的临时对话。
  *Auditable Run Replay, per-conversation sandboxed workspaces, real DOCX/PDF export, and memory-free temporary chats.*
- **本地安装与运行** — `npx fieldnote` 在 `127.0.0.1:8787` 启动本地服务并打开浏览器；也可从源码用 `pnpm setup` / `pnpm dev` 运行；`pnpm run doctor` 检查认证、端口、目录与可选外部工具。
  *Install paths: `npx fieldnote` for a loopback-only local server, or run from source with `pnpm setup` / `pnpm dev`; `pnpm run doctor` checks configuration health.*
- **公开仓库基础设施** — MIT 许可、安全策略与私密漏洞报告流程、贡献指南、Issue/PR 模板，以及在 Ubuntu（Node 20/24）与 macOS（Node 24）上运行 typecheck/test/build 的 CI。
  *Public-repository groundwork: MIT license, security policy, contributing guide, issue and PR templates, and CI across Ubuntu (Node 20/24) and macOS (Node 24).*

**已知边界 / Known boundaries**

- 服务端只绑定 loopback，0.x 没有认证，禁止暴露到公网；Agent 沙箱是应用层防护而非虚拟机边界；`data/agent.db` 未加密。详见 [SECURITY.md](SECURITY.md)。
  *Loopback-only, no authentication in 0.x, application-level sandbox (not a VM boundary), unencrypted local database. See [SECURITY.md](SECURITY.md).*
- macOS 完整支持；Linux 可用但 DOCX/PDF 导出降级；Windows 未测试，建议使用 WSL。
  *macOS is fully supported; Linux works with degraded DOCX/PDF export; Windows is untested (WSL suggested).*
- 单用户本机产品，不接入 PrairieLearn，不建设正式题库或评分系统，不自动提交申请、付款或代发邮件。完整非目标见 [docs/FEATURES.md](docs/FEATURES.md)。
  *Single-user and local by design; explicit non-goals are listed in [docs/FEATURES.md](docs/FEATURES.md).*
