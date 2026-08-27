# 安全策略 / Security Policy

## 支持的版本

Fieldnote 处于 0.x 阶段，只有**最新的 0.x 发布**会收到安全修复。旧的 0.x 版本不做回移植，请先升级到最新版再报告问题。

| 版本 | 状态 |
| --- | --- |
| 最新 0.x | 支持 |
| 更早的 0.x | 不支持，请升级 |

## 设计假设与威胁模型

Fieldnote 是**运行在你自己机器上的单用户工具**，不是多租户隔离的 SaaS。它把一个具备文件读写和命令执行能力的 Claude Agent 放在本机上运行，因此下面这些边界必须在使用前理解清楚。

**网络与鉴权**

- 服务端只允许绑定 loopback 地址（`127.0.0.1` / `::1`），启动时有硬校验；CORS 只接受 localhost 来源。
- **0.x 没有任何认证、授权或审计用户身份的机制。**任何能访问该端口的人就是管理员。禁止通过公网、反向代理、隧道或 `0.0.0.0` 暴露服务。需要给其他人使用之前，必须先加入认证、审批、容器/VM 隔离和独立凭据。
- 飞书渠道使用本地长连接出站，不需要公网入站；`FEISHU_ALLOWED_OPEN_IDS` 是使用者白名单，但列表内的所有身份共享同一记忆空间与同一台机器的能力。

**Agent 执行边界**

- Agent 以 `bypassPermissions` 运行，其约束来自**应用层沙箱**：写入限定在当前对话的工作区目录，输入附件只读，SSH、AWS、GnuPG、gcloud、kube 等敏感目录禁止读取；PreToolUse guard 检查 NUL 字节、路径穿越、绝对路径、symlink 与 realpath 越界，同样规则适用于受控专家子进程；公开网页抓取拒绝 localhost、私网、link-local 和带凭据的 URL。
- **这是防护层，不是虚拟机或容器边界。**配置中仍允许受控的 unsandboxed 命令，且沙箱本身可能存在绕过。只应在你信任的代码与配置上运行。
- `CLAUDE_SETTINGS_MODE=inherit-user` 会**有意**加载你个人的 Claude plugins、skills、MCP 与 permissions，等价于把这些第三方扩展的权限交给 Fieldnote 的 Agent。仅在可信的个人本机使用；CI、共享机器和任何潜在多用户环境必须使用 `isolated`。

**本地数据**

- `data/agent.db`（或 `$FIELDNOTE_HOME` 下的对应文件）是**未加密的 SQLite**。它保存运行配置（包括未做应用层加密的本地 secret 值，如 `ANTHROPIC_AUTH_TOKEN` 与飞书 App Secret）、SDK session 数据、消息内容，以及 Web 展示的 Thinking/Reasoning 流。
- 配置 API 与前端页面不会回传 token 明文，`setup` / `doctor` 也不会打印或复制密钥值；但数据库文件本身不是 secret vault。**不要共享、上传或提交 `agent.db`。**
- Thinking/Reasoning 流不保证已经摘要或脱敏，不应视为安全摘要。
- 磁盘加密、文件权限、备份与操作系统账户安全由使用者负责。Claude Code 位于 `~/.claude` 的 Auto Memory 被显式关闭，跨对话记忆只由本项目的受控 Store 管理。

**不在威胁模型内**

- 拥有该机器本地账户访问权限的攻击者；
- 你主动安装的恶意 Claude plugin / MCP / skill（`inherit-user` 模式下会被加载）；
- 模型输出本身的正确性——教学反馈与外部检索结果都可能出错或过期，重要决定必须由你核对官方来源。

## 报告漏洞

请**不要**用公开 Issue 报告安全问题。

使用 GitHub 的私密漏洞报告：进入仓库的 **Security** 标签页 → **Report a vulnerability**，填写复现步骤、影响范围和你认为的严重程度。

- 目标响应时间：**7 天内**首次回复。
- 修复后会在 [CHANGELOG.md](CHANGELOG.md) 中致谢（可选择匿名）。
- **本项目没有赏金计划。**
- 报告中请不要附带真实密钥、token 或个人隐私数据；如果密钥可能已泄露，请立即轮换。

---

## English summary

Fieldnote is a **single-user, local-first** tool, not an isolated multi-tenant service. Only the **latest 0.x** release receives security fixes.

Key boundaries you must understand before use:

- The server binds **loopback only** (hard-checked at startup) and **0.x ships no authentication whatsoever**. Never expose it to the public internet, a reverse proxy, or a tunnel. Anyone who can reach the port is an admin.
- The agent runs with `bypassPermissions` inside an **application-level sandbox** (workspace-scoped writes, read-only input attachments, denied sensitive directories, path-traversal guards, SSRF-blocked fetches). This is a hardening layer, **not a VM or container boundary** — controlled unsandboxed commands remain possible, so run only trusted code and configuration.
- `data/agent.db` is an **unencrypted SQLite database** holding runtime configuration (including local secret values such as auth tokens and the Feishu app secret), SDK sessions, message content, and the Thinking/Reasoning stream. Configuration APIs never return token plaintext, but the file is not a secret vault — do not share or commit it.
- `CLAUDE_SETTINGS_MODE=inherit-user` intentionally loads your personal Claude plugins, skills, MCP servers, and permissions. Use it only on a trusted personal machine; use `isolated` for CI and shared machines.
- Out of scope: attackers with local account access, malicious extensions you installed yourself, and the factual correctness of model output.

**To report a vulnerability**, use GitHub private vulnerability reporting (repository **Security** tab → **Report a vulnerability**) instead of a public issue. We aim to respond within **7 days**. There is **no bug bounty**. Do not include real secrets or personal data in the report; rotate any key you believe was exposed.
