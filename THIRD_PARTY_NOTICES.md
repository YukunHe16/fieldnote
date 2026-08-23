# 第三方声明 / Third-Party Notices

Fieldnote 本身以 MIT 许可发布（见 [LICENSE](LICENSE)）。仓库中还包含或按需下载下列第三方内容，各自适用其原始许可条款。

Fieldnote itself is released under the MIT License (see [LICENSE](LICENSE)). The repository additionally bundles — or downloads on demand — the third-party materials listed below, each under its own original license.

## 随仓库分发 / Bundled in this repository

### daymade-docs

- 路径 / Path: `apps/server/plugins/daymade-docs`
- 内容 / Contents: `doc-to-markdown`、`docx-creator`、`pdf-creator` 文档转换 skills
- 许可 / License: MIT — Copyright (c) 2025 daymade
- 完整文本 / Full text: [`apps/server/plugins/daymade-docs/LICENSE`](apps/server/plugins/daymade-docs/LICENSE)

### humanizer-zh

- 路径 / Path: `apps/server/plugins/humanizer-zh`
- 内容 / Contents: 中文 AI 文本人性化 skill
- 许可 / License: MIT — Copyright (c) 2026 歸藏
- 完整文本 / Full text: [`apps/server/plugins/humanizer-zh/LICENSE`](apps/server/plugins/humanizer-zh/LICENSE)
- 上游 / Upstream: [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh)，其核心文件翻译自 [blader/humanizer](https://github.com/blader/humanizer)，实用工具部分参考 [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop)

`apps/server/plugins/graduate-admissions` 是本项目自有的受控 skills，适用仓库根目录的 MIT 许可。

## 按需安装，不随仓库分发 / Installed on demand, not bundled

### Anthropic Office skills（pdf / docx / xlsx）

Anthropic 官方的 `pdf`、`docx`、`xlsx` 技能**不包含在本仓库中**，需要时由 `pnpm skills:office` 安装到本机。

These skills are **not distributed with this repository**. Run `pnpm skills:office` to install them locally when you need them.

它们不是 MIT 许可：© Anthropic, PBC，使用受你与 Anthropic 之间的协议约束（[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) / [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)）。安装后请阅读随附的 `LICENSE.txt`。

They are not MIT-licensed: © Anthropic, PBC. Use is governed by your agreement with Anthropic (Consumer or Commercial Terms). Read the accompanying `LICENSE.txt` after installation.

安装位置为 `data/.runtime-plugins/document-skills/`（已在 `.gitignore` 中，永不进入 git），可用环境变量 `FIELDNOTE_RUNTIME_PLUGINS` 覆盖安装根，`pnpm skills:office -- --force` 重新安装。未安装时，技能目录与系统提示词不会提及 pdf/docx/xlsx，Markdown 转 PDF/Word 仍由 daymade-docs 承担；`pnpm doctor` 会显示当前安装状态。

They install into `data/.runtime-plugins/document-skills/` (gitignored, never committed). Override the root with `FIELDNOTE_RUNTIME_PLUGINS`; reinstall with `pnpm skills:office -- --force`. When absent, the skill catalog and system prompt omit pdf/docx/xlsx and Markdown→PDF/Word conversion falls back to daymade-docs; `pnpm doctor` reports the current state.

## 运行时依赖 / Runtime dependencies

npm 依赖的许可信息由各自的包声明，可用 `pnpm licenses list` 查看当前依赖树的完整许可清单。

Licenses for npm dependencies are declared by each package; run `pnpm licenses list` for the full list for the current dependency tree.

可选的外部工具（`uv` / `python3`、`dotnet`、LibreOffice `soffice`、`tesseract`）由使用者自行安装，不随本仓库分发，适用各自的许可条款。

Optional external tools (`uv` / `python3`, `dotnet`, LibreOffice `soffice`, `tesseract`) are installed by the user, are not distributed here, and remain under their own licenses.
