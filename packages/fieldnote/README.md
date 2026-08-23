# fieldnote

A local-first [Claude Agent](https://docs.claude.com/en/api/agent-sdk/overview) workbench for education. It runs entirely on your own machine: a graduate admissions assistant that researches programmes, drafts SOP/CV material and tracks deadlines, plus an adaptive learning loop that turns your sessions into memory the agent reuses. An optional Feishu (Lark) channel lets you talk to the same agent from chat.

## Quick start

```sh
npx fieldnote
```

That starts the server on <http://127.0.0.1:8787>, opens the web app, and creates the database on first run. No account, no cloud service, no telemetry — everything stays in a directory you own.

```sh
npx fieldnote --demo          # try the UI without Claude credentials
npx fieldnote --port 9000     # use a different port
npx fieldnote --data ./work   # keep data somewhere else
npx fieldnote doctor          # check the local environment
npx fieldnote data            # show the resolved data directory
npx fieldnote reset           # move the data directory aside (backup, never delete)
```

## Requirements

- **Node.js 20 or newer.**
- **Claude credentials** — either a local `claude login`, or `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in your environment. Without credentials, start with `--demo` to explore the interface using a scripted runtime.
- Optional: `uv`, `python3`, and LibreOffice for the bundled PDF/DOCX/XLSX document skills. `fieldnote doctor` reports what is missing and what each tool is used for.

## Where your data lives

Everything is written under `~/.fieldnote` by default — `~/.fieldnote/data/agent.db` (SQLite) for conversations, memory and application records, and `~/.fieldnote/data/workspaces/` for files the agent creates. Override the location with `--data <dir>` or the `FIELDNOTE_HOME` environment variable, and put optional settings such as `ANTHROPIC_API_KEY` or the Feishu app credentials in `~/.fieldnote/.env`.

## 中文简介

fieldnote 是一个本地优先的 Claude Agent 教育工作台，包含研究生申请助手与自适应学习闭环，可选接入飞书。运行 `npx fieldnote` 即可在本机 <http://127.0.0.1:8787> 启动，所有对话、记忆与生成的文件都保存在 `~/.fieldnote`，不上传任何服务器。需要 Node.js 20+ 与 Claude 凭据（已 `claude login` 或设置 `ANTHROPIC_API_KEY`）；没有凭据时可用 `npx fieldnote --demo` 体验界面。环境有问题时先运行 `npx fieldnote doctor` 查看诊断。

## Links

Source, documentation and issues: <https://github.com/YukunHe16/fieldnote>

MIT licensed.
