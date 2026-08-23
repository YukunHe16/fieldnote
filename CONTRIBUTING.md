# 贡献指南 / Contributing

欢迎提 Issue 和 PR。**中文和英文的 Issue 都欢迎**，用你更顺手的语言即可 — issues and pull requests in either Chinese or English are equally welcome.

## 开发环境

Node.js 版本以仓库根目录的 [`.nvmrc`](.nvmrc) 为准（当前 `24`），最低要求 **Node ≥ 20**。

```bash
nvm use                      # 或用其他版本管理器读取 .nvmrc
npm i -g pnpm                # 或 corepack enable && corepack prepare pnpm@11.19.0 --activate
pnpm install
pnpm setup                   # 创建 .env 与 data/workspaces，检测本地 Claude 配置；不会覆盖已有 .env
pnpm dev                     # Web http://127.0.0.1:5173 · API http://127.0.0.1:8787
```

`pnpm doctor` 可以随时复查认证、端口、目录、plugins/MCP 与可选外部工具的状态；它只报告配置是否可用，不会打印任何密钥值。

没有 Claude 认证也可以开发：在 `.env` 中设置 `AGENT_RUNTIME=demo`，界面和流式状态都是真实的，只是不调用外部模型。

仓库结构与运行架构见[使用指南的“项目结构与运行架构”一节](docs/USER_GUIDE.md#项目结构与运行架构)。

## 质量门

提交前这三条必须全绿：

```bash
pnpm typecheck
pnpm test
pnpm build
```

CI 会在 Ubuntu（Node 20 与 24）和 macOS（Node 24）上跑同样的命令。请顺手检查 `git diff --check` 没有行尾空白。

## 测试必须密闭

自动化测试使用内存 SQLite 与 demo runtime，**不消耗模型额度、不访问网络、不需要飞书凭据**。

- **不要**引入需要网络请求、真实 Anthropic API key、真实飞书应用或任何外部服务的测试用例；
- 需要模型行为时，请对 runtime 边界打桩，而不是真的发起 query；
- 需要时间或随机性时，请注入可控实现，保证结果确定；
- 不要把真实个人数据、申请材料或 token 写进 fixture。

任何一条做不到的用例都不应进入 `pnpm test`。

## 提交与 PR

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(learning): add transfer-example verification
fix(server): reject cross-conversation attachment ids
docs(readme): document npx fieldnote install path
chore(ci): run tests on node 24
```

常用类型：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`perf`、`build`、`ci`。

PR 请保持小步：

- 一个 PR 解决一件事，便于 review 和回滚；大改动请先开 Issue 讨论方向；
- 描述清楚**为什么**改，不只是改了什么；
- 勾选 PR 模板里的质量门，确认 CI 是绿的；
- 改动 UI 时附上前后截图或短录屏；
- 涉及安全边界（loopback 绑定、沙箱规则、密钥处理、`inherit-user` 行为）的改动，请在描述中显式说明影响，并对照 [SECURITY.md](SECURITY.md)。

安全漏洞请**不要**用公开 Issue 或 PR 报告，走 [SECURITY.md](SECURITY.md) 里的私密报告流程。

## 文档

面向用户的行为变化需要同步文档：README 是入口，[docs/USER_GUIDE.md](docs/USER_GUIDE.md) 是日常使用语义，[docs/FEATURES.md](docs/FEATURES.md) 是中英对照的完整功能与边界。请特别注意不要在文档里夸大能力——已知的限制和非目标必须如实保留。
