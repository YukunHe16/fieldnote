# 申学助手：资料源、隐私与能力边界

申学助手面向美国、加拿大、香港和新加坡的硕士、MPhil 与 PhD 申请。它仍是一个对话 Agent：Profile 只提供受控的 system prompt、Skills、MCP、可见专家和定时模板，主 Agent 自行决定如何组合这些能力。

## 能力组合

- 项目研究员：学校、项目、导师、实验室和政策调研；
- 资料核验员：独立检查关键事实、来源权威性和时效；
- 文书写作：依据用户事实台账起草 CV、SOP、Research Statement 和邮件；
- 文书审校：检查事实一致性、项目匹配、要求覆盖和表达；
- 申请看板：周期、项目、材料、任务、来源和截止日期；
- 定时报告：每日申请计划、每周申请回顾。

简单问题由主 Agent 直接处理。跨项目研究或正式文书才通常调用专家；用户可以明确要求审校、跳过审校或指定所需能力。

## 来源优先级

1. 学校、院系、Graduate School、研究组、导师主页和官方申请系统；
2. 政府、考试机构和官方教育门户；
3. OpenAlex、Crossref、ORCID、ROR 等学术元数据；
4. 排名、论坛和聚合站只用于发现线索，不作为最终招生事实。

基线入口：

- 美国：[EducationUSA](https://educationusa.state.gov/complete-your-us-application-graduate)、[College Scorecard](https://collegescorecard.ed.gov/assets/InstitutionDataDocumentation.pdf)；
- 加拿大：[EduCanada](https://www.educanada.ca/programs-programmes/index.aspx?lang=eng)；
- 香港：[Study in Hong Kong](https://www.studyinhongkong.edu.hk/en/)；
- 新加坡：MOE、ICA、A\*STAR 和各大学官网；
- 研究匹配：[OpenAlex](https://developers.openalex.org/api-reference/introduction)、[Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)、[ORCID](https://info.orcid.org/what-is-orcid/services/public-api/)、[ROR](https://ror.readme.io/docs/rest-api/)。

截止日期、费用、语言要求、奖学金、导师任职或招生状态必须附官方 URL 与核验时间；无法确认时应明确显示“未核验”，不能推测补全。

## Web 与 MCP 安全

- 官方网页工具只允许公共 HTTP/HTTPS 地址；localhost、私网、链路本地地址和带 URL 凭据的请求会被拒绝；
- 网页仅保存必要证据摘要、哈希和核验时间，不镜像完整页面；
- OpenAlex/Crossref/ROR 只辅助发现研究关系，不能证明导师当前招生；
- 看板 MCP 不提供删除工具，低风险写入也只应在用户明确要求后进行；
- 首次引导会创建申请周期和申请档案；项目、任务与材料要求可以在看板中直接更新，也可以由用户在对话中明确要求后写入；
- 候选链接由 Claude Agent SDK 内置 `WebSearch` 发现，不写死学校域名；官方页面由 `admissions_evidence.fetch_official_page` 读取，前端渲染页面会尽量抽出元数据、嵌入 JSON 和同站候选链接；内置搜索不可用时才回退到应用托管搜索；
- Artifact 只能从当前对话工作区复制，拒绝绝对路径、`..`、越界路径和超过 20 MB 的文件；
- DOCX/PDF 由本机受控转换器从 Markdown/纯文本生成，不允许模型用文本伪造二进制文件。

## 记忆与材料

- 通用语言和偏好属于全局记忆；
- 申请目标、项目和任务历史只在 `graduate-admissions` Profile 中召回；
- 不同 Profile 的任务不会在定期精炼时合并；
- GPA、考试分数、项目状态和材料状态以申请看板为事实来源；
- 成绩单全文、护照、资金证明、推荐信原文和健康信息不进入自动长期记忆；
- 飞书通知不发送上述敏感原文。

文书只能使用用户确认的经历和数据。缺失信息应成为待确认问题；不得伪造研究、成绩、论文、引用、推荐人评价、导师互动或录取概率。不同学校对 AI 辅助政策不同，提交前必须核对目标项目的最新规定。

## 定时任务

- `每日申请计划`：每天 08:00，读取未来 30 天截止日期、材料缺口和未完成任务；
- `每周申请回顾`：每周一 08:00，读取过去七天申学对话和看板变化；
- 时区固定为 `Asia/Shanghai`，模板默认关闭；
- 服务离线时，多个错过周期合并为下次启动后的一次补跑；
- 同一计划时刻幂等，失败最多重试三次；
- 定时 Agent 使用独立一次性 Query，不恢复聊天 Session，报告也不进入自动记忆；
- 后台任务只读，不自动提交申请、发送邮件或覆盖文件。

## SDK 流式说明

Agent SDK 的主会话支持 token delta，但原生 Agent subagent 不转发 token 级 delta。内置申学专家因此通过应用托管的 delegation MCP 启动独立 Agent SDK Query，并把真实 delta 多路复用到同一 SSE。托管专家不设置美元预算上限，但仍受各自 `maxTurns`、共享超时/停止信号和并发 2 限制；其实际成本继续计入运行记录。停止主回答会同时中断专家；默认排队消息不会打断正在运行的专家。
