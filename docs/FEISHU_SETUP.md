# 飞书机器人本地接入

本项目使用“企业自建应用 + 机器人能力 + 官方 Node SDK 长连接”。飞书官方说明：长连接仅要求运行环境可以访问公网，本地不需要公网 IP、域名或内网穿透；同一应用的多个 client 采用集群消费而非广播。

官方参考：

- [事件订阅概述](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?from=from_parent_docs)
- [使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)
- [官方 Node SDK Channel](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md)

## 1. 创建测试应用

1. 进入飞书开放平台开发者后台，创建“企业自建应用”。
2. 优先创建并关联“测试企业和人员”。测试版配置可以立即生效；测试版与正式版使用不同的 App ID 和 App Secret。
3. 在“添加应用能力”中启用“机器人”。
4. 将应用可用范围限制为自己的测试账号。

## 2. 开通权限

首版文字对话需要：

| 权限 key | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊中 @ 机器人的消息 |
| `im:message:send_as_bot` | 以机器人身份回复 |
| `im:message.reactions:write_only` | 收到请求后立即添加确认表情 |
| `cardkit:card:write` | 更新 AI 流式消息卡片 |

不要为了群聊使用而默认申请 `im:message.group_msg`；本项目只响应明确 @ 机器人的消息。

项目已经支持把用户发送的图片和常见文档下载到当前对话工作区。要使用附件，请再根据飞书“获取消息中的资源文件”接口为应用申请 `im:message` 或后台显示的对应只读资源权限；只做文字对话时可以不申请这项权限。

缺少资源权限、下载失败或文件类型不支持时，机器人会在原会话提示哪个附件没有读取，不会再静默忽略。

## 3. 配置事件订阅

1. 先在本地启动服务，保证 SDK 可以建立连接。
2. 在开发者后台进入“事件与回调 → 事件配置”。
3. 选择“使用长连接接收事件”。
4. 添加“接收消息 v2.0”，事件 key 为 `im.message.receive_v1`。
5. 在“回调配置”中添加新版卡片回传交互 `card.action.trigger`，用于停止、重新回复和新对话按钮。
6. 保存并发布测试版配置。

飞书要求长连接 handler 在 3 秒内完成且不抛异常。代码中的 handler 只做 `message_id` 去重、落库和入队，Claude 执行与回复由后台继续完成。

## 4. 配置本地凭据

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ALLOWED_OPEN_IDS=ou_xxx
WEB_APP_URL=http://127.0.0.1:5173
```

`FEISHU_ALLOWED_OPEN_IDS` 支持逗号分隔多个 open_id。当前版本是单用户本机产品，所有允许的 open_id 会共享同一个跨对话记忆空间，因此实际使用时应只配置自己的身份。

### 允许名单、最近发信人与配置优先级

- **名单留空 = 允许全部**。留空时，飞书“应用可用范围”内的任何人都可以使用这个机器人，并且和你共享同一份本机记忆。这是本机单用户产品的既定取舍：可用范围是第一道闸门，`pnpm run doctor` 也会就此给出提醒。只想给自己用，就把自己的 open_id 填进名单。
- **名单非空时**，名单外的人第一次私聊只会收到一句“此机器人为私人助手。”，同一个 open_id 之后完全静默；群聊里不回任何内容。两种情况都不会创建会话、不会触发 Agent 运行。
- **找自己的 open_id**：先用自己的账号给机器人发一条单聊消息，然后在网页端「连接飞书机器人」里点“读取最近发信人”，在列表中点“添加”就会写入上方的允许名单，不必去开放平台翻事件日志。最近 10 个单聊发信人会被记住（含未被允许的），重启后仍在。
- **配置优先级**：网页端保存的飞书配置写入本机 SQLite（`local_settings` 的 `feishu.config`），启动时覆盖 `.env` 里的 `FEISHU_*`。想回到 `.env` 的配置，清空网页端保存的配置即可。

`WEB_APP_URL` 是回复卡片中“打开对话”的目标地址。开发模式保持 `5173`；使用服务端生产构建托管页面时可改为 `http://127.0.0.1:8787`。

启动：

```bash
pnpm dev
```

日志出现 `Feishu long connection is ready` 后：

- 在飞书中搜索机器人并发送单聊消息。
- 将机器人加入测试群，使用 `@机器人 消息`。
- 群主会话按 `chat_id` 共用一段上下文；消息已经位于话题内时，再按 `chat_id + root/thread_id` 建立该话题自己的上下文并在原话题回复。

## 5. 运行语义

- 单聊：一个 allowlisted 用户维护当前会话，`/new` 更换会话。
- 新对话：`/new`、`/clear` 或完成卡片中的“新对话”都会清空当前绑定，并回复“新对话已创建”。
- 对话标题与记忆：首轮回答完成后由当前配置的 LLM 生成短标题；同一次独立结构化分析会整理新任务的记忆，不写入原对话 session。
- 群聊：群主会话共用一条绑定，已有话题各自独立；没有 @ 的群消息不会进入 Agent。机器人不会为群主会话里的每次 @ 自动创建新话题。
- 重复推送：按 `message_id` 幂等，重复事件不会创建第二个 run。
- 即时确认：机器人收到有效请求后会立即添加 `THUMBSUP` 表情；缺少 reaction 权限时不影响后续回答。
- 流式回复：优先使用官方 `channel.stream()`；CardKit 不可用时降级为最终 Markdown 消息。
- 卡片状态：等待时循环展示 `Thinking` 动画并提供“停止回复”；首个正文到达后切换为同卡片流式回答。
- 完成操作：卡片底部提供“去往网页端”“重新回复”和“新对话”。“去往网页端”使用 `WEB_APP_URL`；默认 loopback 地址通常只能在运行服务的本机打开。
- 多条输入：同一会话串行；普通新消息排队，`/guide` 会把消息补充进当前 run。
- 跨渠道记忆：飞书与 Web 共用结构化记忆；`/new` 和 `/clear` 不会清除记忆，飞书卡片不显示记忆引用提示。

## 6. 故障排查

### 收不到消息

- 确认应用已启用机器人能力并发布了包含最新权限和事件的版本。
- 确认本地日志显示长连接成功。
- 确认单聊用户在应用可用范围内；群聊中机器人已入群且被明确 @。
- 在开发者后台“日志检索 → 事件日志”查看平台是否推送了 `im.message.receive_v1`。

### 能收消息但不能回复

- 检查 `im:message:send_as_bot` 和 CardKit 权限是否已随版本发布。
- 检查机器人在群内是否有发言权限。
- 飞书对同一用户、同一群有额外 QPS 限制；SDK 抛出 `rate_limited` 时等待后重试。

### 重复回复

- 检查是否运行了多个使用同一 App ID 的本地实例。
- 确认 SQLite 数据库可写，`inbound_events` 的 `(channel, idempotency_key)` 唯一约束没有被绕过。

### 正式发布

测试完成后，将机器人能力、权限、事件订阅和可用范围同步到正式版，创建版本并提交企业管理员审核。不要把测试版 App Secret 复制到正式环境。
