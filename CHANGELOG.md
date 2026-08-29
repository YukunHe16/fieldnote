# 更新日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构与[语义化版本](https://semver.org/lang/zh-CN/)。0.x 阶段公开接口仍可能变化。

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Public interfaces may still change during 0.x.

## [0.3.0](https://github.com/YukunHe16/fieldnote/compare/v0.2.0...v0.3.0) (2026-08-29)


### Features

* add verifiable cache bank pipeline ([e9ab501](https://github.com/YukunHe16/fieldnote/commit/e9ab50119109bc2b303d261e12a6a4238a3160e9))
* **eval:** add a post-test stability gate ([7f0d25a](https://github.com/YukunHe16/fieldnote/commit/7f0d25a16b33c2376e3d06e93c4a1916100b932b))
* **eval:** add a post-test stability gate ([0f5377b](https://github.com/YukunHe16/fieldnote/commit/0f5377b8efa07d25b563cfac5395648b6fc4d10e))
* **eval:** require structured evidence-backed post-tests ([15f22bb](https://github.com/YukunHe16/fieldnote/commit/15f22bb371ac03ad3ba794f77680880eb743294a))
* **eval:** require structured evidence-backed post-tests ([02196b1](https://github.com/YukunHe16/fieldnote/commit/02196b1413ac354b5cfb94d2dd48e14fe5d554c1))


### Bug Fixes

* bound cache bank evaluator context ([#27](https://github.com/YukunHe16/fieldnote/issues/27)) ([5cabecf](https://github.com/YukunHe16/fieldnote/commit/5cabecf87a12a0ba95f79ffbca5ba99dc484e255))
* **eval:** isolate rubric scopes and recover empty judges ([5aebc07](https://github.com/YukunHe16/fieldnote/commit/5aebc074c471d7dfccc754f4bfc9169e496b9845))
* **eval:** isolate rubric scopes and recover empty judges ([30c32bd](https://github.com/YukunHe16/fieldnote/commit/30c32bde1cb895fa511870cabf593d1918e3281a))
* **eval:** quiesce timed-out tutor runs ([31f2c6a](https://github.com/YukunHe16/fieldnote/commit/31f2c6a2eeb13a919878fe7b19bed951597e9f13))
* **eval:** quiesce timed-out tutor runs ([4a5ab15](https://github.com/YukunHe16/fieldnote/commit/4a5ab1599dbb7e811627e35773e0fe7650771805))
* generate cache candidates one per slot ([08884b1](https://github.com/YukunHe16/fieldnote/commit/08884b1423d950dafa615176e78a4c8696166f22))
* **learning:** recover missing eval tool transitions ([8b37d2f](https://github.com/YukunHe16/fieldnote/commit/8b37d2f7d31f50a65c26cdd1a5e63ef9fbf4d26e))
* **learning:** recover missing eval tool transitions ([931b109](https://github.com/YukunHe16/fieldnote/commit/931b109d4954baae46c3fe2ad911c4a5e8468af9))
* make cache generator response an array ([4220836](https://github.com/YukunHe16/fieldnote/commit/4220836524898b8443de8e63376e710c2c87ebc7))
* recover empty cache bank model responses ([dc520dc](https://github.com/YukunHe16/fieldnote/commit/dc520dcaa1006365ea3cc7fd01cefbf315e2a6cc))
* retain invalid cache generator responses ([4599cff](https://github.com/YukunHe16/fieldnote/commit/4599cff3a8b3e401fa48f3f070dc9e279892a6c4))
* set cache generator reasoning high at 20k ([bf76e1d](https://github.com/YukunHe16/fieldnote/commit/bf76e1da86c9f7e0ba18d00d2170900c692fe1d0))
* switch cache generator to glm flash ([d7a2063](https://github.com/YukunHe16/fieldnote/commit/d7a2063fd0a7d06b42a68ade29d9e35175d3ad88))

## [0.2.0](https://github.com/YukunHe16/fieldnote/compare/v0.1.0...v0.2.0) (2026-08-28)


### ⚠ BREAKING CHANGES

* remove the graduate-admissions feature line

### Features

* **eval:** add a continued-conversation baseline and an opt-in evolving eval ([b36e034](https://github.com/YukunHe16/fieldnote/commit/b36e034db068ef89d6116798a202be297640b6d7))
* **eval:** batch replay evaluation with baseline and candidate arms ([ab400b7](https://github.com/YukunHe16/fieldnote/commit/ab400b7bbd1c8c647b405a13786c99bf9aeb1271))
* **eval:** fill the feedback factorial and pin the item bank in CI ([4b4cbd5](https://github.com/YukunHe16/fieldnote/commit/4b4cbd5c6ec38188aa3be4316e06a8812285e172))
* **eval:** learner-stubbornness tier so adaptivity is a variable, not an assumption ([1557705](https://github.com/YukunHe16/fieldnote/commit/1557705710df2397ca6d835f9b838e0acb7ae39f))
* **eval:** literature-grounded learning-loop evaluation set and simulated-learner runner ([009330f](https://github.com/YukunHe16/fieldnote/commit/009330f8d5536e1e9e62873527a8650363a4a057))
* **eval:** make the exit check a transfer task and the stubborn tier bite ([f6432a4](https://github.com/YukunHe16/fieldnote/commit/f6432a467516d9553aad826b2e757544cd3e9acf))
* **eval:** measure whether the learner accepts wrong feedback ([11c7be1](https://github.com/YukunHe16/fieldnote/commit/11c7be15189ebab62c04442e734efa025559f1ea))
* **eval:** pin the learner and grader to their own provider ([dd30a7b](https://github.com/YukunHe16/fieldnote/commit/dd30a7b97c3d84c6fa833255a1bf96bbb17561fe))
* **evolution:** track capability usage and suggest disabling weak ones ([dbff1c8](https://github.com/YukunHe16/fieldnote/commit/dbff1c8f8f9e41f1af0ea8d493671233c41e3b00))
* **feishu:** learning loop on Feishu with /learn and outcome cards ([981a53b](https://github.com/YukunHe16/fieldnote/commit/981a53b8ea6e74037b64e650fcb0caaa06da2df7))
* **learning:** anchor spaced revisits on the missing plan ([1cdde41](https://github.com/YukunHe16/fieldnote/commit/1cdde41d70b097eb9ff6177524e8bf6137a9be0f))
* **learning:** escalation handoff reports with owner paging ([56e43d2](https://github.com/YukunHe16/fieldnote/commit/56e43d25da8ad214bf358f87462e072b62970fa9))
* **learning:** in-loop practice generation with three-tier host review ([86a2f93](https://github.com/YukunHe16/fieldnote/commit/86a2f931acc5391824b1a79e091260b4225da5ae))
* **learning:** invent teaching approaches from winning rounds ([b50c080](https://github.com/YukunHe16/fieldnote/commit/b50c080295d1f6183faa7093f0451a7922b712e7))
* **learning:** one-shot baseline condition, eval dataset, metrics and anonymized export ([17cbe42](https://github.com/YukunHe16/fieldnote/commit/17cbe42092d1b4b60edcac9075436f3c5698317d))
* **learning:** practice-item calibration protocol script ([0faa350](https://github.com/YukunHe16/fieldnote/commit/0faa3507a3e8399b615536dbc33aee89d60fd27a))
* **learning:** say when a loop is a revisit of an earlier one ([cec4cdc](https://github.com/YukunHe16/fieldnote/commit/cec4cdc731827fff14d2bcae2008a85cd46f0617))
* **learning:** seeded permuted-block randomization for research conditions ([9b0d198](https://github.com/YukunHe16/fieldnote/commit/9b0d198ecb692bf70febfababbab0a216d8afd72))
* **learning:** spaced reviews and a host-resolved scheduler time zone ([0511454](https://github.com/YukunHe16/fieldnote/commit/0511454d556c57e6be91828a3d8a4a4b4ff45275))
* **learning:** stall watchdog and session-denominator reliability metrics ([8e72cdd](https://github.com/YukunHe16/fieldnote/commit/8e72cdd7915ef2e80bb343a10774835de6695a86))
* **learning:** tell the tutor what the six difficulty types mean ([9e8a75f](https://github.com/YukunHe16/fieldnote/commit/9e8a75f1f878f0313e0a6843098e34f5ba8b2840))
* **learning:** voice the spaced-review revisit in the UI language ([1c9d8ac](https://github.com/YukunHe16/fieldnote/commit/1c9d8ac459d594bbcd8ce72b7314773a1a0db768))
* **research:** human-readable HTML export view; configurable review delays for local testing ([0d1a280](https://github.com/YukunHe16/fieldnote/commit/0d1a280f5b11c1b697a1891d37f766b321eec1b0))
* **research:** loop-first corpus browser and a per-loop learning report ([e7547a6](https://github.com/YukunHe16/fieldnote/commit/e7547a621253820b53899a5d2c397d2dfca5b5c3))
* **research:** say it in the learner's words, and give the charts room ([e3625c4](https://github.com/YukunHe16/fieldnote/commit/e3625c4714b23a6c8a78b1f5f8a1ce8130f3298a))
* **runtime:** one-click provider presets for compatible endpoints ([7b7f36d](https://github.com/YukunHe16/fieldnote/commit/7b7f36df852cb38a7781077c562b89c7ddf8b9ef))
* **web:** lead the interface with the learning loop ([54e1711](https://github.com/YukunHe16/fieldnote/commit/54e1711afba9055dc666a261037987c570825d43))
* **workbench:** first-class participant axis with two-way owner isolation ([20974b2](https://github.com/YukunHe16/fieldnote/commit/20974b2ffdd58673b284422226116c592695c5db))


### Bug Fixes

* **eval:** drop the context-tier suffix before calling the model directly ([fef3ae3](https://github.com/YukunHe16/fieldnote/commit/fef3ae3b4532e10f746f53048f80f36f3179a091))
* **eval:** grade post-tests on substance, and report both coverage readings ([67f2007](https://github.com/YukunHe16/fieldnote/commit/67f2007c0585cf6646c8949b94c6d7070f5d0e44))
* **eval:** let the per-turn wait budget follow the provider ([64eccbe](https://github.com/YukunHe16/fieldnote/commit/64eccbe7ca531d0e84e9199f9108094ff5aaa5b9))
* **eval:** make measurements reproducible and release-safe ([008a25c](https://github.com/YukunHe16/fieldnote/commit/008a25cbc526194465006aab023038c289bddcf8))
* **eval:** make measurements versioned and fail closed ([db1ec1b](https://github.com/YukunHe16/fieldnote/commit/db1ec1b7545f44aba28a0d213757ee7425474285))
* **eval:** make the replay baseline arm artifact-free and batch-resilient ([750d126](https://github.com/YukunHe16/fieldnote/commit/750d126355da4d6041db1cd92eb78c98518e2a63))
* **eval:** phase-matched recovery nudges in the runner; record stall-fix verification ([9bf23cf](https://github.com/YukunHe16/fieldnote/commit/9bf23cfaf56337a06016316037b3e4d688e58b19))
* **eval:** stop the control half reading as its own opposite ([69524d5](https://github.com/YukunHe16/fieldnote/commit/69524d53bef06ec496049542ad06f0304d222a05))
* **eval:** verify the running server build ([1c25bdb](https://github.com/YukunHe16/fieldnote/commit/1c25bdb3dfcfbcdc96acf6fb9bd3cc7aaaee58a1))
* **evolution:** unbias the disable baseline and blame the rejected run ([581eb92](https://github.com/YukunHe16/fieldnote/commit/581eb92578f62dd6a90cd11cd3aa179635d9a463))
* **export:** shield UUID join keys from redaction; give the evaluator time to answer ([72ddda3](https://github.com/YukunHe16/fieldnote/commit/72ddda339b717cb0785f2b79087fd2e3b74a0df9))
* **export:** stop the redactor from eating the research export's time axis ([49f008c](https://github.com/YukunHe16/fieldnote/commit/49f008c98710fd0cdd1bcaabc6f8f45b3c996507))
* **feishu:** distill on card confirms, dedupe outcome cards, honest errors ([df34030](https://github.com/YukunHe16/fieldnote/commit/df340309faad4c59ac9b77bf638eb190cd94e2e8))
* **learning:** a partial confirmation owes another round too ([070d6ed](https://github.com/YukunHe16/fieldnote/commit/070d6ed8541becfa207d19df05608f5508ee9e9f))
* **learning:** background model budgets that a thinking model can meet ([805a81c](https://github.com/YukunHe16/fieldnote/commit/805a81ce40ebc0008ce1f7424fc58bd7b26217b8))
* **learning:** classify a revisit's practice items by incident, not run ([53b2036](https://github.com/YukunHe16/fieldnote/commit/53b2036b36cd82fc55142994e9bebe96efec2792))
* **learning:** delivery-verified attribution, review-task linkage, and variant guards ([87ffc09](https://github.com/YukunHe16/fieldnote/commit/87ffc0966a691aa155be3e6a7b44576d87bf9694))
* **learning:** label the multi-turn condition and keep it out of live statistics ([0714d89](https://github.com/YukunHe16/fieldnote/commit/0714d89efe92c34f74dd46ce4c481423000a57c7))
* **learning:** read spaced-review delay overrides at scheduling time ([2438aea](https://github.com/YukunHe16/fieldnote/commit/2438aea2f42804e54fbe32569804b5af2fef73ca))
* **learning:** state-directed next-step instructions and redirecting guard errors ([4040585](https://github.com/YukunHe16/fieldnote/commit/40405852604d9cbabcee8ff460768bd300a36ec8))
* **learning:** survive the trigger re-parse when rebuilding experiences ([e996a79](https://github.com/YukunHe16/fieldnote/commit/e996a7936445989b4577e3ccde8ad4b1b87a61dc))
* **metrics:** stop the confidence chart from stretching, and unglue the export links ([f7f381f](https://github.com/YukunHe16/fieldnote/commit/f7f381fca34b0611f746ce9b7aefc4679d872be5))
* **release:** clean and audit publish artifacts ([1204e6d](https://github.com/YukunHe16/fieldnote/commit/1204e6d6657ebe7dec6e8307a6012b2e3775a82b))
* **runtime:** keep a host tool-search flag from reshaping the tutor's tools ([0c41fff](https://github.com/YukunHe16/fieldnote/commit/0c41fff148aeea62feca273c89cdfc76b1dc6178))
* **server:** gate explicit signals, wire runner deps, and add a true replay baseline ([415a79c](https://github.com/YukunHe16/fieldnote/commit/415a79c20222b409f6d3aba14be826ac8333179b))
* **server:** keep synthetic conversations out of memory and evolution ([2c42305](https://github.com/YukunHe16/fieldnote/commit/2c42305ebe3a348155f012ee7981b563a1297395))
* **server:** make a configured model credential authoritative ([5a9461f](https://github.com/YukunHe16/fieldnote/commit/5a9461ff559733f66bd4e4848efa510e27d73de3))
* **storage:** remove the duplicate event sequence index ([5d78f6d](https://github.com/YukunHe16/fieldnote/commit/5d78f6dc56414d52d9f8680aaeda58f3ed27a345))
* **web:** confirm what a settings save actually did ([c07d649](https://github.com/YukunHe16/fieldnote/commit/c07d64933114e258e7ce5e1d0779b93fb3ef1717))
* **web:** keep empty topic scopes filtered and stop try-another after escalation ([b2c069e](https://github.com/YukunHe16/fieldnote/commit/b2c069e8fed41098a83c79e8760d2d92d4e051ec))
* **web:** let the learning sheet fit on screen ([19ed9de](https://github.com/YukunHe16/fieldnote/commit/19ed9ded536a46e9bb8e267cd63f77157b65a118))
* **web:** line the diagnostics row up with the connections above it ([53e9d44](https://github.com/YukunHe16/fieldnote/commit/53e9d44d0ebc6cffdae897e242d620599fbc3861))
* **web:** one scroll region per popover, not three ([4daa9ca](https://github.com/YukunHe16/fieldnote/commit/4daa9ca9a7d439632700ca36b2827bd839a2bd4c))


### Code Refactoring

* remove the graduate-admissions feature line ([9b7eb01](https://github.com/YukunHe16/fieldnote/commit/9b7eb01305d136463e93b2fe2c03a31c67801731))

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
