# Fieldnote

本地优先的 Claude Agent 教育工作台：一个会从证据里诊断你卡在哪一层误解、用明确的策略讲清楚、再用为这次诊断现出的题检验的助手——最终结论由你、而不是模型给出。

[![CI](https://github.com/YukunHe16/fieldnote/actions/workflows/ci.yml/badge.svg)](https://github.com/YukunHe16/fieldnote/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520%20run%20%C2%B7%20%E2%89%A522.13%20dev-brightgreen)](.nvmrc)
[![npm](https://img.shields.io/npm/v/fieldnote?color=cb3837&logo=npm)](https://www.npmjs.com/package/fieldnote)

[English](README.md) · **简体中文**

![Fieldnote](docs/media/hero.png#gh-dark-mode-only)
![Fieldnote](docs/media/hero-light.png#gh-light-mode-only)

## 功能

**对话式学习模式** — 一条 educational on-call 闭环：设定目标 → 定位具体困难 → 诊断原因 → 选一种讲法或练习 → 收集验证证据 → 由你确认结果。6 类困难、8 种教学策略、5 种验证方式，每个 incident 最多三轮干预。系统只能提出 outcome，"理解了 / 部分理解 / 仍未解决"必须由你确认。学生看到的对话只有讲解和练习，诊断与策略信息都在学习面板里。学习面板附带指标页签（解决率、干预轮数、系统判定校准）；开启研究模式后还可选择对照条件（自适应回路 vs 同轮数的持续对话基线，或一次性反馈基线）并导出匿名化研究数据（[字段说明](docs/RESEARCH_EXPORT.md)），配套一套可复跑的离线评测集（[设计与文献依据](docs/internal/LEARNING_EVAL.md)）。回路还会主动值守：解决后按 +2 天 / +5 天回访出新迁移练习；三轮未解决时生成结构化交接报告（并可推送飞书）；成功的讲法会被蒸馏成候选教学方式，人审试用、按归因数据考核后转正。学习确认与 `/learn` 指令同样可在飞书使用。

![学习模式与固定案例](docs/media/learning-mode.png)

**受控自进化与跨对话记忆** — 教学策略按 Beta posterior 从你确认过的经验里演进，达到阈值才生成待审修订，并先在冻结的历史快照上做确定性预览，由你启用、拒绝或回滚。通用能力自进化产出新的 Skill 或子代理候选，同样需人工审核且不能绕过硬性安全检查。跨对话记忆分个人资料、偏好、目标和项目，由本项目的 SQLite 记忆层管理，会定期精炼，绝不修改你手动置顶的条目。

**飞书渠道** — 同一套能力接入飞书机器人，本地长连接，不需要公网 IP 或内网穿透；CardKit 卡片流式展示 Thinking、当前 Skill 和专家活动，支持 `/new`、`/agent`、`/stop`、`/continue`、`/guide`。

次级能力：**Run Replay**（在冻结的本地输入边界上重放一次运行，用于审计与能力启用前后对比）、**工作区沙箱**（每段对话独立目录，Agent 写入被限制在其中，输入附件只读）、**文档技能**（Markdown 源文件导出为真实 DOCX/PDF，另可按需安装 Office 技能）、**临时对话**（不读写跨对话记忆，结束即清理）。

## 研究

学习模式把辅导当作一个**教育值班回路**而不是一次性的回答:困难成为带诊断的 *incident*,每次教学动作是带策略与预期信号的 *intervention* 记录,理解由 *verification* 检验——系统裁决与学习者本人确认分开存储,三轮未解的 incident 会*升级*给人并生成结构化交接报告。treatment、outcome、failure 都是一等公民记录,这正是回路可被研究的原因。

**先诊断,后干预。** 回路点名缺失的那一层——这里是异常处理直觉背后的递归计划缺口——并把置信度与证据留在学习者看不到的面板里;右侧同时展示系统裁决与学习者确认这两条独立记录:

![计划缺口诊断,系统裁决与学习者确认分离](docs/assets/demo-planning-gap.png)

**换策略有案可查。** 第一轮以 `partial` 收场时,回路切换策略(这里是对比示例 → 类比示例)并用迁移任务而非复读题重新检验——每一轮都带自己的理由:

![两轮记录:策略切换与诚实的 partial 裁决](docs/assets/demo-strategy-switch.png)

**弃权是能力,不是失败。** 当剩下的障碍是只有人类教师才能回答的问题时,回路选择升级而非编造答案,并写下交接报告:逐轮试过什么、学习者仍做不到什么、人类接手后可以先试什么:

![升级的 incident 与结构化交接报告](docs/assets/demo-escalation-handoff.png)

这套仪器面向的候选研究问题:*有界的、计划感知的支架式辅导,相比一次性计划反馈,能否改善计划习得与迁移?不确定性感知的验证,能否在不过度升级的前提下降低学生对错误 AI 反馈的接受度?对话优先的补救回路,能否降低明确定义误概念的干预至掌握次数?*

**证据状态,如实陈述。** 以上画面是真实 agent 会话跑在合成演示场景上;这里没有任何关于真实学生的证据。截至 2026-08-25 的存档评测 cohort 中,在旧题库与旧 prompt 协议下,回路的首次诊断与剧本误概念一致 **166/176(94%)**;这一历史结果不代表当前 HEAD。结果对比(自适应回路 vs 基线)已搁置,直到能用真实学习者运行——因为 LLM 模拟学生无法可信地"学不会"。完整的仪器复盘、证据与后续研究设计见 [docs/internal/EVAL_LESSONS.md](docs/internal/EVAL_LESSONS.md)。方法与题目来源:[docs/internal/LEARNING_EVAL.md](docs/internal/LEARNING_EVAL.md) · 匿名导出:[docs/RESEARCH_EXPORT.md](docs/RESEARCH_EXPORT.md)。

## 快速开始

```bash
npx fieldnote
```

首次运行会进入配置向导，随后在 `127.0.0.1:8787` 启动本地服务并自动打开浏览器。数据、配置和会话工作区默认写入 `~/.fieldnote`，可用 `FIELDNOTE_HOME` 覆盖。

如果本机的 Claude CLI 已经能正常使用，这里不需要任何额外配置：Fieldnote 会沿用 `~/.claude/settings.json` 和 `~/.claude.json` 中已经生效的认证、模型映射、plugins、skills、permissions 与 MCP，不需要复制 token。没有 Claude CLI 配置时，可以在“个人工作区 → 模型服务”里填写 `ANTHROPIC_AUTH_TOKEN`、可选的 `ANTHROPIC_BASE_URL` 和模型名称，保存后从下一条消息生效。只想先看界面，用 `npx fieldnote --demo`（或把 `AGENT_RUNTIME` 设为 `demo`）：Demo 会展示真实的会话和流式状态，但不调用外部模型。

其他子命令：`npx fieldnote doctor` 体检本机环境，`npx fieldnote data` 显示当前数据目录，`npx fieldnote reset` 备份并清空数据目录。

### 从源码运行

```bash
git clone https://github.com/YukunHe16/fieldnote.git
cd fieldnote
pnpm setup   # 等价于 pnpm workbench:setup
pnpm dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)（API 在 `127.0.0.1:8787`，健康检查 `/api/health`）。

源码开发需要 Node ≥ 22.13（pnpm 11 的要求；`npx fieldnote` 运行只需 Node ≥ 20）。`pnpm setup` 会检查 Node.js 与 pnpm，在缺少依赖时运行 `pnpm install`，创建 `.env` 和 `data/workspaces`（绝不覆盖已有 `.env`），检测本地 Claude 认证、兼容 Base URL、plugins 与 MCP，并且只告诉你配置是否可用，不打印任何密钥值。源码模式下数据保存在仓库内的 `data/`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm setup` | 首次初始化；保留已有配置 |
| `pnpm run doctor` | 安全检查认证、MCP、plugins、端口、目录与外部工具 |
| `pnpm skills:office` | 按需安装 Anthropic 官方 pdf/docx/xlsx 技能（默认不随仓库分发） |
| `pnpm dev` | 启动 Web 与 API 开发服务 |
| `pnpm typecheck` | 检查全部 TypeScript 类型 |
| `pnpm test` | 运行服务端与前端测试 |
| `pnpm build` | 生成生产构建 |
| `pnpm audit:package` | 检查 npm 实际文件清单并拒绝已退役功能的残留产物 |
| `NODE_ENV=production pnpm start` | 运行已构建的本地生产版本 |

## 技术栈与项目结构

TypeScript · React 19 + Vite · Fastify · SQLite（better-sqlite3）· [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) · MCP · 飞书 CardKit · Vitest · Biome。

```text
apps/web                 React + Vite 对话工作台（SSE 流式、学习面板）
apps/server              Fastify API、SQLite、Agent Runtime、专家协作、飞书渠道
apps/server/plugins      随仓库分发的受控 Skills plugin（文档、humanizer-zh）
packages/contracts       Web / Server / Channel 共用类型
packages/fieldnote       发布到 npm 的 `fieldnote` CLI（npx 入口）
scripts/workbench.mjs    本地 setup、doctor 与按需技能安装
data/                    本机数据：SQLite、会话工作区、自进化产物（不进 git）
```

质量门为 `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm audit:package`，共约 400 个测试，全部密闭运行——不联网、不消耗模型额度。

## 配置参考

大多数用户只需要运行 setup，无需手动修改下表。**接入第三方 Anthropic 兼容服务（DeepSeek / Kimi / GLM 等）时，推荐直接在“个人工作区 → 模型服务”里选择服务商预设**：接口地址与下面这些别名映射会自动填好，只需粘贴密钥。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `FIELDNOTE_HOME` | `~/.fieldnote`（源码运行时为仓库根目录） | 数据根目录覆盖；`DATABASE_PATH` 与 `AGENT_WORKSPACE_ROOT` 相对它解析 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 本地 API 地址 |
| `DATABASE_PATH` | `./data/agent.db` | SQLite 数据库 |
| `AGENT_WORKSPACE_ROOT` | `./data/workspaces` | 会话工作区根目录 |
| `AGENT_RUNTIME` | `auto` | `auto`、`claude` 或 `demo` |
| `ANTHROPIC_AUTH_TOKEN` | 空 | Claude 或兼容服务的访问令牌 |
| `ANTHROPIC_BASE_URL` | Anthropic 默认地址 | 可选的兼容 API 地址 |
| `ANTHROPIC_MODEL` | 空 | 兼容服务使用的默认模型名称 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME` 等别名映射 | 空 | 兼容服务的别名映射。Fieldnote 的后台任务（生成标题、整理记忆）请求 `sonnet` 别名，缺少映射时聊天正常但后台任务会失败 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 空 | 子代理使用的模型 |
| `CLAUDE_SETTINGS_MODE` | `auto` | `auto`、`inherit-user` 或 `isolated` |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | 可选的 Claude 配置目录 |
| `AGENT_MODEL` | `sonnet` | 模型别名或完整 ID；可由本地映射解析 |
| `AGENT_MAX_CONCURRENCY` | `2` | 同时运行的 Agent 数量 |
| `AGENT_MAX_TURNS` | `30` | 单轮最大 Agent turns |
| `AGENT_RUN_TIMEOUT_MINUTES` | `20` | 应用层超时 |
| `AGENT_MAX_BUDGET_USD` | `2` | 主 Agent 单轮预算上限；托管专家（受委派的子代理）不设置美元预算上限 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 空 | 同时设置后启用飞书 |
| `FEISHU_ALLOWED_OPEN_IDS` | 空 | 允许使用机器人的用户 open_id |
| `WEB_APP_URL` | `http://127.0.0.1:5173` | 飞书卡片“打开对话”按钮使用的本地 Web 地址 |

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| macOS | 完整支持 | 开发与日常使用的主平台 |
| Linux | 可用，导出有条件 | DOCX 导出使用内置极简格式（需要 `zip` 命令）；PDF 导出需要安装 LibreOffice（`soffice`）；其余功能正常 |
| Windows | 未测试 | 建议在 WSL 中运行 |

文档技能可选依赖外部工具：`uv` / `python3`（PDF 与 Markdown 转换）、`dotnet`（docx-creator）、LibreOffice `soffice`（xlsx 重算、非 macOS 的 PDF 导出）、`tesseract`（OCR）。缺哪个不影响启动，`pnpm run doctor` 会逐项报告。

## 项目状态与非目标

当前是 `0.x` 的**单用户本机产品**：没有登录与鉴权，接口与数据结构仍可能出现破坏性变更，升级前请留意 [更新日志](CHANGELOG.md)。

有意不做的事情：不接入 PrairieLearn，也不建设题库、考试、评分或课程管理系统；学习模式不声称已证明真实学习效果，不使用强化学习，也不会自动启用教学策略；不是多租户 SaaS；不会自动付款、发邮件或替你做任何不可逆的决定。完整边界见 [功能总览的「明确的非目标与限制」](docs/FEATURES.md#15-明确的非目标与限制--explicit-non-goals-and-limitations)。

## 安全模型

- 服务端只允许绑定 loopback（有硬校验），0.x 版本没有登录与鉴权，**不要通过公网或反向代理暴露**；
- Agent 以 `bypassPermissions` 运行在应用层沙箱内：写入限定在当前对话工作区，SSH/AWS/GnuPG/gcloud/kube 等敏感目录禁止读取。这是防护层，**不是虚拟机边界**；
- `data/agent.db` 是未加密的 SQLite，保存运行配置（含本地 secret 值）、SDK session 与 Thinking 流；配置 API 不回传 token，但数据库本身不是 secret vault，不要共享；
- `CLAUDE_SETTINGS_MODE=inherit-user` 会有意加载你个人的 Claude plugins、skills、MCP 和 permissions，只适合可信本机；CI 与共享机器必须用 `isolated`；
- 飞书 App Secret 存于本机 SQLite，只由服务端读取；Claude Code Auto Memory 被显式关闭，记忆只由本项目管理；
- 这是单用户本机产品，不是多租户隔离的 SaaS。密钥若曾被粘贴到聊天、Issue 或日志中，应立即轮换。

完整威胁模型与漏洞报告流程见 [SECURITY.md](SECURITY.md)。

## 遇到问题

从源码运行时，第一步永远是 `pnpm run doctor`（发布版 CLI 则用 `npx fieldnote doctor`）。它只显示配置是否可用，不会输出 token 或 Base URL。

- **页面打不开**：确认 `pnpm dev` 的两个进程都没退出；检查 `5173` / `8787` 是否被占用；Web 用 `5173`，不要把 API 地址当页面地址。
- **显示 Demo runtime**：看 doctor 的 `Selected runtime`；已有 Claude CLI 配置时确认 `CLAUDE_SETTINGS_MODE` 不是 `isolated`，或在“个人工作区 → 模型服务”保存认证，下一条消息即切换。
- **提示“organization has disabled Claude subscription access”或“organization does not have access to Claude”**：本机 `claude login` 的账号被其组织禁用了 Claude Code —— 凭据存在但不可用，原生 `claude` 命令同样会失败。doctor 会直接报 FAIL。改用 Anthropic API Key，或在“个人工作区 → 模型服务”里选一个兼容服务商；你配置的凭据会优先于本机登录。
- **辅导循环不再触发**（不开 incident，回复看起来却完全正常）：工具检索被打开了，它会把大部分工具藏到一次检索之后。Fieldnote 默认会为 Agent 子进程固定 `ENABLE_TOOL_SEARCH=false`，但 `inherit-user` 模式下 Claude Code 仍可从 `~/.claude/settings.json` 覆盖这个值——请从该文件中删除 `ENABLE_TOOL_SEARCH`。doctor 会以 `Tool surface` 报告这一例外；运行时 canary 也会在导师误用 `ToolSearch`、没有调用学习工具时写入日志。
- **MCP 或 plugin 没出现**：确认 doctor 能发现对应名称；本地复用需要 `CLAUDE_SETTINGS_MODE=auto` 或 `inherit-user`。项目不会把 MCP 凭据复制进 SQLite 或前端。
- **飞书收不到消息**：确认日志出现 `Feishu long connection is ready`；检查应用版本是否已发布最新权限和事件；群聊中必须明确 @机器人。详见 [飞书接入指南](docs/FEISHU_SETUP.md#6-故障排查)。

## 文档

- [使用指南](docs/USER_GUIDE.md) — 对话管理、Agent 控制、学习模式、记忆、工作区与飞书接入的完整语义
- [项目完整功能总览 / Complete Feature Guide](docs/FEATURES.md) — 中英对照的功能、边界与非目标
- [飞书机器人本地接入](docs/FEISHU_SETUP.md)
- [飞书、自进化、记忆](docs/飞书-自进化-记忆.md)
- [贡献指南](CONTRIBUTING.md) · [安全模型与漏洞报告](SECURITY.md) · [更新日志](CHANGELOG.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

## 许可

[MIT](LICENSE)。随仓库分发的第三方 Skills 及按需安装的 Anthropic Office 技能各自适用其原始许可，见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 视觉

界面以 iOS/macOS 的纯白与暗黑语义主题为基础；明亮主题中的五线谱、离散彩色音符和行走节奏受到陈奕迅 2017 年专辑 [《C'mon in~》](https://music.apple.com/tw/album/cmon-in/1440909180)启发，但全部由原创 CSS/SVG 绘制，仓库不包含唱片封面素材。
