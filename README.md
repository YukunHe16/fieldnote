# Fieldnote

本地优先的 Claude Agent 教育工作台：一个能陪你做完整个研究生申请季、并在你卡住时真正把知识讲清楚的助手。

[![CI](https://github.com/YukunHe16/fieldnote/actions/workflows/ci.yml/badge.svg)](https://github.com/YukunHe16/fieldnote/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](.nvmrc)

**English TL;DR** — Fieldnote is a local-first Claude Agent workbench for education. It runs entirely on your own machine: a graduate-admissions assistant (school research, SOP/CV drafting, a deadline-and-materials board, scheduled reports) plus an adaptive learning loop that diagnoses where you are stuck, teaches in at most three governed rounds, and evolves its teaching strategy only from outcomes you confirm. Run `npx fieldnote` to start a local server on `127.0.0.1:8787`; the same agent is also reachable from a Feishu (Lark) bot. For the complete bilingual feature reference — including explicit non-goals — see [docs/FEATURES.md](docs/FEATURES.md).

![Fieldnote](docs/media/hero.png#gh-dark-mode-only)
![Fieldnote](docs/media/hero-light.png#gh-light-mode-only)

## 功能

**申学助手** — 面向美国、加拿大、香港和新加坡硕士/MPhil/PhD 申请。项目与院校调研、选校策略、导师匹配、CV/SOP/PS/Research Statement 与套磁面试准备；申学看板管理申请周期、目标项目、材料、任务与截止日期，每条结论都可以打开官方来源。复杂文书由受控专家（项目研究员、资料核验员、写作、审校）真实协作完成，不是固定工作流。

**对话式学习模式** — 一条 educational on-call 闭环：设定目标 → 定位具体困难 → 诊断原因 → 选一种讲法或练习 → 收集验证证据 → 由你确认结果。6 类困难、8 种教学策略、5 种验证方式，每个 incident 最多三轮干预。系统只能提出 outcome，"理解了 / 部分理解 / 仍未解决"必须由你确认。学生看到的对话只有讲解和练习，诊断与策略信息都在学习面板里。

![学习模式与固定案例](docs/media/learning-mode.png)

**受控自进化与跨对话记忆** — 教学策略按 Beta posterior 从你确认过的经验里演进，达到阈值才生成待审修订，并先在冻结的历史快照上做确定性预览，由你启用、拒绝或回滚。通用能力自进化产出新的 Skill 或子代理候选，同样需人工审核且不能绕过硬性安全检查。跨对话记忆分个人资料、偏好、目标和项目，由本项目的 SQLite 记忆层管理，会定期精炼，绝不修改你手动置顶的条目。

**飞书渠道与定时报告** — 同一套能力接入飞书机器人，本地长连接，不需要公网 IP 或内网穿透；CardKit 卡片流式展示 Thinking、当前 Skill 和专家活动，支持 `/new`、`/agent`、`/stop`、`/continue`、`/guide`。定时任务提供每周一 08:00 申学周报与每日 08:00 当日计划，默认关闭，可投递到 Web 或飞书，报告只读。

次级能力：**Run Replay**（在冻结的本地输入边界上重放一次运行，用于审计与能力启用前后对比）、**工作区沙箱**（每段对话独立目录，Agent 写入被限制在其中，输入附件只读）、**文档技能**（Markdown 源文件导出为真实 DOCX/PDF，另可按需安装 Office 技能）、**临时对话**（不读写跨对话记忆，结束即清理）。

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

`pnpm setup` 会检查 Node.js 与 pnpm，在缺少依赖时运行 `pnpm install`，创建 `.env` 和 `data/workspaces`（绝不覆盖已有 `.env`），检测本地 Claude 认证、兼容 Base URL、plugins 与 MCP，并且只告诉你配置是否可用，不打印任何密钥值。源码模式下数据保存在仓库内的 `data/`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm setup` | 首次初始化；保留已有配置 |
| `pnpm doctor` | 安全检查认证、MCP、plugins、端口、目录与外部工具 |
| `pnpm skills:office` | 按需安装 Anthropic 官方 pdf/docx/xlsx 技能（默认不随仓库分发） |
| `pnpm dev` | 启动 Web 与 API 开发服务 |
| `pnpm typecheck` | 检查全部 TypeScript 类型 |
| `pnpm test` | 运行服务端与前端测试 |
| `pnpm build` | 生成生产构建 |
| `NODE_ENV=production pnpm start` | 运行已构建的本地生产版本 |

## 配置参考

大多数用户只需要运行 setup，无需手动修改下表。

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
| `CLAUDE_SETTINGS_MODE` | `auto` | `auto`、`inherit-user` 或 `isolated` |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | 可选的 Claude 配置目录 |
| `AGENT_MODEL` | `sonnet` | 模型别名或完整 ID；可由本地映射解析 |
| `AGENT_MAX_CONCURRENCY` | `2` | 同时运行的 Agent 数量 |
| `AGENT_MAX_TURNS` | `30` | 单轮最大 Agent turns |
| `AGENT_RUN_TIMEOUT_MINUTES` | `20` | 应用层超时 |
| `AGENT_MAX_BUDGET_USD` | `2` | 主 Agent 单轮预算上限；托管申学专家不设置美元预算上限 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 空 | 同时设置后启用飞书 |
| `FEISHU_ALLOWED_OPEN_IDS` | 空 | 允许使用机器人的用户 open_id |
| `WEB_APP_URL` | `http://127.0.0.1:5173` | 飞书卡片“打开对话”按钮使用的本地 Web 地址 |

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| macOS | 完整支持 | 开发与日常使用的主平台 |
| Linux | 可用，导出有条件 | DOCX 导出使用内置极简格式（需要 `zip` 命令）；PDF 导出需要安装 LibreOffice（`soffice`）；其余功能正常 |
| Windows | 未测试 | 建议在 WSL 中运行 |

文档技能可选依赖外部工具：`uv` / `python3`（PDF 与 Markdown 转换）、`dotnet`（docx-creator）、LibreOffice `soffice`（xlsx 重算、非 macOS 的 PDF 导出）、`tesseract`（OCR）。缺哪个不影响启动，`pnpm doctor` 会逐项报告。

## 安全模型

- 服务端只允许绑定 loopback（有硬校验），0.x 版本没有登录与鉴权，**不要通过公网或反向代理暴露**；
- Agent 以 `bypassPermissions` 运行在应用层沙箱内：写入限定在当前对话工作区，SSH/AWS/GnuPG/gcloud/kube 等敏感目录禁止读取。这是防护层，**不是虚拟机边界**；
- `data/agent.db` 是未加密的 SQLite，保存运行配置（含本地 secret 值）、SDK session 与 Thinking 流；配置 API 不回传 token，但数据库本身不是 secret vault，不要共享；
- `CLAUDE_SETTINGS_MODE=inherit-user` 会有意加载你个人的 Claude plugins、skills、MCP 和 permissions，只适合可信本机；CI 与共享机器必须用 `isolated`；
- 飞书 App Secret 存于本机 SQLite，只由服务端读取；Claude Code Auto Memory 被显式关闭，记忆只由本项目管理；
- 这是单用户本机产品，不是多租户隔离的 SaaS。密钥若曾被粘贴到聊天、Issue 或日志中，应立即轮换。

完整威胁模型与漏洞报告流程见 [SECURITY.md](SECURITY.md)。

## 遇到问题

第一步永远是 `pnpm doctor`（或 `npx fieldnote doctor`）。它只显示配置是否可用，不会输出 token 或 Base URL。

- **页面打不开**：确认 `pnpm dev` 的两个进程都没退出；检查 `5173` / `8787` 是否被占用；Web 用 `5173`，不要把 API 地址当页面地址。
- **显示 Demo runtime**：看 doctor 的 `Selected runtime`；已有 Claude CLI 配置时确认 `CLAUDE_SETTINGS_MODE` 不是 `isolated`，或在“个人工作区 → 模型服务”保存认证，下一条消息即切换。
- **MCP 或 plugin 没出现**：确认 doctor 能发现对应名称；本地复用需要 `CLAUDE_SETTINGS_MODE=auto` 或 `inherit-user`。项目不会把 MCP 凭据复制进 SQLite 或前端。
- **飞书收不到消息**：确认日志出现 `Feishu long connection is ready`；检查应用版本是否已发布最新权限和事件；群聊中必须明确 @机器人。详见 [飞书接入指南](docs/FEISHU_SETUP.md#6-故障排查)。

## 文档

- [使用指南](docs/USER_GUIDE.md) — 对话管理、Agent 控制、学习模式、申学助手、记忆、工作区与飞书接入的完整语义
- [项目完整功能总览 / Complete Feature Guide](docs/FEATURES.md) — 中英对照的功能、边界与非目标
- [申学助手：资料源、隐私与能力边界](docs/ADMISSIONS_ASSISTANT.md)
- [飞书机器人本地接入](docs/FEISHU_SETUP.md)
- [飞书、自进化、记忆](docs/飞书-自进化-记忆.md)
- [贡献指南](CONTRIBUTING.md) · [安全模型与漏洞报告](SECURITY.md) · [更新日志](CHANGELOG.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

## 视觉

界面以 iOS/macOS 的纯白与暗黑语义主题为基础；明亮主题中的五线谱、离散彩色音符和行走节奏受到陈奕迅 2017 年专辑 [《C'mon in~》](https://music.apple.com/tw/album/cmon-in/1440909180)启发，但全部由原创 CSS/SVG 绘制，仓库不包含唱片封面素材。
