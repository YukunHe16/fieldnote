# 学习回路离线评测设计（Learning Eval）

评测回答一个问题：**同一批带误解的学习场景，自适应回路（on-call）与基线条件相比表现如何？**
基线有两个：`multi-turn`（与 on-call 同样的三轮预算，但没有策略推荐、不禁止重复已失败的
策略、不能升级——把"结构"从"多聊了几轮"里隔离出来，默认对比项）与 `one-shot`（单轮反馈，
回答更窄的问题）。这是 computing-education 方向候选 RQ 的离线预演。

> **2026-08-25 状态**：结果对比（解决率等）已搁置——LLM 模拟学习者无法可信地"学不会"，
> 详见 [EVAL_LESSONS.md](EVAL_LESSONS.md)；诊断准确率只作为截至该日旧协议 cohort 的历史测量，
> 不代表当前 HEAD（见文末）。

## 组成

- 题目：`apps/server/eval/learning-items/*.json`，当前共 31 题、3 个 difficulty 家族
  （pg 6 · cm 6 · fu 19）；每题的出口检查带一个迁移任务（fresh case），概念清单附 judge 用的
  `credit` 判分说明。结构不变量由 `apps/server/test/eval-items.test.ts` 在 CI 里守着——题库是
  评测的判分依据，写错不会报错，只会静默算错分。
- 运行器：`scripts/learning-eval.mjs`，驱动本地运行中的服务的公开 HTTP API；学习会话使用
  `datasetKind=eval`（策略固定默认顺序、不写经验、不产策略修订，保证题目间独立）。正式运行默认
  拒绝 dirty checkout，也要求 `/api/health` 的 clean server build SHA 与 runner checkout 相同；只有
  显式传 `--allow-dirty` / `--allow-server-mismatch` 才能覆盖，报告会把该 run 标成不可精确复现。
- 模拟学习者：一个便宜模型按题目 persona 扮演学生；stubborn 层的"是否已巩固"由运行器
  按剧本条件判定后注入 persona，不留给模型自己推断。
- 判分：离线 post-test 使用 `structured-v1` 五栏回答；judge（temperature 0）同时看到原 worked
  example、exit check 和回答，并按 `evidence-v2` 为每个 concept 返回栏位和逐字引用。宿主再验证引用
  是该栏真实子串、且 concept 可以使用该栏；伪造引用或串栏确定性降为不计分，不重试、不让正则补分。
  正则清单只作每次判分的随行第二意见，报告写明两者一致率；同时报末轮与最优两种覆盖读数。
- 产出：`data/eval-runs/<ts>/results.json` + `report.md`；每个结果带协议 fingerprint、runner/server
  Git SHA 与匹配状态、题库与 judge prompt SHA-256、选题清单、模型/provider 及判分失败记录。服务端聚合可看
  `GET /api/learning/metrics?datasetKind=eval`，但它可能包含同 participant 的早先运行，单次报告以自己的
  `records` 为准。

```bash
node scripts/learning-eval.mjs --dry-run     # 校验题目与计划
node scripts/learning-eval.mjs               # 当前全量 31 题 × 2 条件（on-call vs multi-turn）
node scripts/learning-eval.mjs --items pg-sum-nested --conditions on-call
```

正式评测不要复用日常数据库。先在一个终端用独立 data root 启动服务，再从另一个终端指向它：

```bash
FIELDNOTE_HOME=data/eval-runtime pnpm run:local -- --api-port 8790
node scripts/learning-eval.mjs --base http://127.0.0.1:8790
```

这样 token delta、合成会话和校准记录不会继续膨胀日常 `data/agent.db`；不同冻结协议需要完全隔离时，
给 `FIELDNOTE_HOME` 换一个新目录。

### Post-test judge 稳定性门

历史 27 个自由回答属于 `legacy-freeform`，只保留既有报告供读取；它们不能在 `evidence-v2` 下伪装成
有原题/迁移栏位的新数据，也不能和 `structured-v1` 混在同一稳定性报告。

当前门使用 4 道从未运行过的 feedback 题，每题冻结 complete、original-only、transfer-only 三个
五栏答案，共 12 条；manifest 与每条答案都有 SHA-256，看到结果后不得修改。每条独立判两次：

```bash
node scripts/learning-posttest-stability.mjs \
  --input data/eval-runs/posttest-holdout-v1/manifest.json
# 中断后：
node scripts/learning-posttest-stability.mjs \
  --input data/eval-runs/posttest-holdout-v1/manifest.json \
  --resume data/eval-runs/posttest-stability-<ts>/results.json
```

脚本固定默认并发 4，每条结果完成后原子 checkpoint；resume 按 `(answerId, repeat)` 跳过已经记录的
成功或失败，不会重复消费模型。当前正式门槛是 12/12 格式解析、24 次判分 0 error、verdict
12/12 一致、精确概念集合至少 11/12 一致，且所有实际获得 credit 的 concept 都有宿主验证通过的
引用。正则只作第二意见。通过只表示**可重复**，不表示 judge 对人类标准是正确的。

五栏固定为：

```text
ORIGINAL_CONCLUSION:
ORIGINAL_EVIDENCE:
GENERAL_METHOD:
TRANSFER_CONCLUSION:
TRANSFER_EVIDENCE:
```

五栏必须各出现一次且非空；格式失败记 `post_test_format_error`，不会让 judge 猜或自动修答案。
`transfer-applied` 只能引用 transfer 两栏；`grader-*-supported` 只能引用
`ORIGINAL_CONCLUSION`；其他 concept 只能引用 original/general 三栏。

### 分阶段线上验证边界

本协议目前只用于离线模拟评测，不改变 Web、飞书或日常学习对话。离线门通过后，线上按三步走：

1. Web 研究模式保持自由回答，只在内部要求 judge 给逐字引用，先验证 evidence contract 能否处理自然语言。
2. 在 Web 研究模式增加一个独立五栏条件，与自由回答并列，记录完成率、作答时间、格式错误、放弃率、
   答案完整度和 judge 稳定性；五栏既可能改善测量，也可能成为教学支架，不能混为一谈。
3. 只有可测性改善且完成/放弃指标可接受，才考虑普通 Web；飞书和 conversation-first 模式最后评估。

没有真实参与者数据前，任何阶段都不能宣称五栏模板改善学习效果。

新 eval record 同时保存 `incidentId`、`diagnosedDifficultyType`、`diagnosisHypothesis`；因此当前协议的
诊断审计可只靠 `results.json` 完成。旧记录缺这些字段时，审计脚本仍回退读取原 SQLite。

## 学习者顽固度分层（tier）

同一批题目跑两层，内容恒定、只动学习者持久性——把"自适应什么时候值得"做成显式实验变量，
而不是把题目调到 on-call 恰好能赢：

| 层 | persona 更新规则 | 回答的问题 |
| --- | --- | --- |
| `mild`（默认） | 导师清楚讲到解锁概念即改口 | 轻度误解下，一次讲透是否已经足够？ |
| `stubborn`（`--tier stubborn`） | **首次应用新概念必然带旧信念残余**（首个迁移作答按旧模型走）；只有"针对本人错误的再反馈 + 换一种讲法"之后才真正巩固 | 当单轮反馈结构上不充分时，回路能否把第二次机会兑换成解决？ |

stubborn 规则的依据是概念转变与 worked-example 文献中的经典现象：新信息被同化进旧图式、
首次独立应用时回退。**必须向读者言明**：该层的设计有意使 one-shot 结构上不充分，
因此它测量的不是"自适应是否存在优势"，而是"回路是否能兑现这个机会"——on-call 在此层
仍可能失败（换错策略、停滞、三轮升级），失败会如实计入。两层合起来构成交叉分析：
自适应溢价随学习者顽固度的变化。

历史归档截至 2026-08-25 包含 72 个 stubborn 会话；它们属于旧题库 / 旧 prompt 协议。
当前 prompt 与当前 31 题版本尚未跑 stubborn，因此不能用那 72 个会话代表当前 HEAD，也不能说
stubborn 从未运行过。

## 方法边界（对外表述必须带上）

1. **模拟学习者不是学生。** persona 是"概念门控"式脚本：只有当导师明确讲到解锁概念时才改口。
   结果说明回路在模拟下的行为差异，不能推断真实学习效果。
2. **post-test 固定，判分器必须单独校准。** 导师每次提出系统判定后，运行器把题目自带的
   **固定 post-test（出口自解释题）**直接问模拟学习者（不进入导师对话）。temperature 0 的
   judge 按概念清单判实质，正则清单只作为随行第二意见，绝不再充当最终 verdict。逻辑尝试固定为
   4K/default-thinking → 8K/default-thinking；仅当两次都完全没有 text 且 provider 是 DeepSeek Anthropic
   时，追加一次同模型 4K / `reasoning.effort=none` 恢复。坏 JSON、缺项或其他 provider 不改变判尺；
   最终失败则整条 run 记 measurement error。每次尝试只保存预算、模式、stop reason、usage、block
   类型/长度和错误类别，不保存 thinking 内容。两个条件使用同一 post-test 与判分配置，但在人工校准
   完成前不能把 judge 称为确定性或可信量尺；系统判定与最终判定仍分开保存，供校准分析使用。
3. **小样本，描述性呈现。** 不做显著性检验。
4. 题面全部原创；文献只作为误解类别与设计依据（见下）。

## 题目设计依据（文献）

### planning_gap（6 题）— 递归/列表处理的计划缺失

对准 programming plans / scaffolding 方向。误解类别来自递归心智模型研究：新手普遍持有
looping model（把递归当单帧循环）而非 copies model；base case 的识别与构造是独立困难；
学生倾向修补代码表面而不是先建立"出口 / 缩小 / 组合"的高层计划。

- Kahney, [What do novice programmers know about recursion](https://dl.acm.org/doi/10.1145/800045.801618) (CHI '83) — looping vs copies model。
- Dicheva & Close, [Mental Models of Recursion](https://doi.org/10.2190/AGG9-A5UD-DEK0-80EN) (JECR 1996)。
- Sanders et al., [The case of base cases: why are they so difficult to recognize?](https://www.researchgate.net/publication/220808380) (ITiCSE '06)。
- 综述：[Informatics in Education 13(1), 2014](https://files.eric.ed.gov/fulltext/EJ1064322.pdf)。

题目：嵌套求和的 isinstance 补丁（pg-sum-nested）、树叶计数的 while 单指针（pg-count-leaves，
looping model）、全局累加器泄漏（pg-reverse-accumulator，return-composition 缺失）、
快速幂只有偶数分支（pg-power-halving，base case + 奇数归约缺失）。

### feedback_uncertainty（当前 19 题）— EiPE 式作答与冲突/含错评分

对准 LLM grading reliability / 学生对错误反馈的接受度。EiPE（Explain in Plain English）
要求目的层描述而非逐行复述，是该系列工作的核心 rubric 区分；自动评分会犯错，
学生如何对待与自己一致/不一致、听起来权威/朴素的反馈是研究对象。

- [Autograding "Explain in Plain English" questions using NLP](https://zilles.cs.illinois.edu/papers/fowler_EiPE_NLP_SIGCSE_2021.pdf) (SIGCSE '21)。
- [Code Generation Based Grading for EiPE](https://arxiv.org/html/2311.14903)；[SIGCSE '24 版本](https://doi.org/10.1145/3626253.3635542)。
- [Evaluating AI Models for Autograding EiPE Questions](https://dl.acm.org/doi/10.1145/3774752) (ACM TiiS)。

题目自带 ground truth（哪份评分有证据支持）：逐行复述 vs 目的层（fu-eipe-max，B 对）、
错误答案被宽松评分器放行（fu-eipe-swap，A 对——测"接受错误正面反馈"）、二分查找死循环的
奇偶红鲱鱼（fu-binary-search-loop，B 对）、权威口吻的错误复杂度反馈（fu-complexity-triangle，
学生原答案对——测"在权威压力下放弃正确答案"）。

**因子矩阵与对照组。** 最初 15 题（9 轻信 + 6 对照）按三个二值因子铺满 8 格：本格所描述的
那份反馈（`focalGrader`）**是否错** × 它**肯定还是否定**学习者 × 语气**朴素还是权威**。
`sound-*` 那半边是对照——那里 focal 的反馈其实是**对的**，而 persona 的信念恰恰在推着
学习者去推开它。没有这半边，指标分不清"轻信"和"一律不信"：一个把所有反馈都拒掉的
学习者在轻信那半边会得到和恰当怀疑的学习者一样漂亮的成绩。

判定来自 `groundTruth.acceptanceConcept`（正确结论）在出口检查里**缺席**：缺席 = 学习者
最终**站到了没有证据支持的那一边**；未作答记为 null，不计入。注意这一个量在两半边是
**两种相反的错误**——`wrong-*` 半边是轻信（顺着错的走），`sound-*` 半边是过度拒斥
（把对的推开）。`scripts/learning-eval.mjs` 因此按格报告并**分半边汇总**，绝不合并成
单一"接受率"：合并会把"一律不信"读成好判断。

当前题库在这 15 题之外又补了 4 道**单信念、非对照**题，用来把"信念数"和"是否对照"
两个变量拆开；因此本家族当前是 19 题。下文的 15 题 / 27 题数字都是扩充前历史 run 的上下文，
不是当前 31 题题库的结果。

**单信念 vs 双信念（一个刻意保留的分组）。** 最早 6 题每题脚本了**两个**信念——一个关于
学科内容、一个关于信谁——而 tutor 稳定地诊断出其中一个、漏掉另一个,judge 按整个信念列表
打分于是判 partial。这正是本家族诊断准确率最低（85%，50/59，全部 8 条 partial 都在这里）
的结构性原因，而 cm/pg 是单信念家族，分别 100% / 98%。随后加入的 9 题（当时）只脚本
"信谁"这一条，学习者开场的错答是情境事实而非会去辩护的立场。**两组刻意不混**：如果
单信念组的诊断准确率明显更高，上面那个结构性解释就得到了验证。注意这**不是**改评分口径——
截至 8 月 25 日旧协议 cohort 的 166/176（94%）计算方式没有动；但后续 prompt 与题库已经变化，
这个数字不能代表当前 HEAD。

> **2026-08-27 实测：这个解释没有成立。** 全 27 题 on-call 一轮（tutor / 模拟学习者 /
> judge 全部 `deepseek-v4-flash-vision-exp`）测下来，fu 家族诊断准确率在每一种切分下
> 都是同一个数：双信念 4/6、单信念 6/9、单信念对照 4/6、单信念轻信 2/3——**全部 67%**。
> 去掉第二条信念没有带来任何改善。样本很小（3–9），四个 67% 有巧合成分，但方向明确：
> 预测的"单信念应显著更高"没有出现。
>
> 逐条读 judge 的理由，真正的失败模式是另一回事，**不是"漏掉两条中的一条"，而是
> 把诊断往学科内容上拉**。五个未达 match 的案例里：三个（`fu-eipe-max`、
> `fu-both-graders-wrong`、`fu-sound-rejection-plain-mutable-default`）诊断了代码/概念
> 本身而漏掉了"该信谁"；另外两个（`fu-sound-rejection-authoritative`、
> `fu-wrong-endorsement-authoritative-purity`）抓住了信任判断，却**额外发明**了一条
> 剧本里没有的内容误解。也就是说 tutor 把"这个学习者哪里不懂代码"当成了默认问题，
> 而剧本写的困难是"这个学习者如何决定相信谁"——单信念题里它照样这么做。
>
> 这条比原假设更值得跟进，也更贴本家族的研究动机：系统识别"内容误解"明显强于识别
> "认识论困难"。当时的下一步是补**单信念的非对照题**；当前题库已补 4 道，把两个变量
> 分开，但尚未按当前 31 题 / 当前 prompt 协议重跑。

### conceptual_misconception（6 题）— cache 存储层级的 3C 误解

对准 Computer Architecture 教学与可验证练习。3C 模型（compulsory/conflict/capacity，
Hennessy & Patterson 标准教材框架）中 conflict miss 的成因最难理解，是教学模拟器文献
反复处理的对象。

- [3C 模型参考](http://thebeardsage.com/cache-misses-the-three-cs/)；教学困难背景：
  [An execution-driven simulation tool for teaching cache memories](https://www.academia.edu/19683161)。

题目：空 cache 被叫"满"（cm-conflict-not-capacity）、冷启动一切皆 compulsory
（cm-compulsory-inflation）、关联度万能论的 LRU 循环反例（cm-associativity-limits）、
write-back 每次写都到内存（cm-write-policy）。每题的访问序列都可由宿主确定性模拟出
标准答案——这也是后续"可验证出题器"对位件的种子。

## 题目 schema

```jsonc
{
  "id": "pg-sum-nested",
  "difficultyType": "planning_gap",        // 6 类之一
  "topicKey": "programming-plans",         // eval 数据集内的主题分组
  "title": "…",
  "opening": "学习者的第一条消息（含代码/错误信念）",
  // 仅 fu 家族。结构化后才可按格子统计"站错边率"：
  //   wrongGrader     哪位评分者是错的（"both" 表示两位都错）
  //   focalGrader     本题这一格所描述的那份反馈出自谁；它的对错/语气/立场决定格子。
  //                   注意它不是"学习者被吸引的那一份"：对照题里学习者恰恰想推开它。
  //   temptingIsWrong focalGrader 是否就是错的那位（false = 对照题）。
  //                   必须等于 wrongGrader === focalGrader，CI 里有断言。
  //   valence / tone  focalGrader 那份反馈肯定还是否定学习者、语气权威还是朴素
  //   acceptanceConcept  正确结论对应的概念 id；没命中它就是站到了没有依据的一边
  //   note            哪位评分者对、为什么
  // 旧的自由文本形式仍可加载（读作 note），但算不出这项指标。
  "groundTruth": { "wrongGrader": "A", "focalGrader": "A", "temptingIsWrong": true,
                   "valence": "endorses", "tone": "plain",
                   "acceptanceConcept": "grader-b-supported", "note": "…" },
  "persona": {
    "beliefs": ["初始错误信念…"],          // fu 新题只写"信谁"这一条，见下
    "style": "作答风格与顽固度",
    "unlockConcepts": ["解锁概念 id…"]      // 目前仅作文档，harness 未读取
  },
  "concepts": [                             // 最终判定的概念清单
    { "id": "base-case", "label": "…", "patterns": ["正则…"] }
  ]
}
```

## 运行协议

每题 × 每条件一条独立对话：开会话（eval + condition）→ 发开场消息 → 真实 Agent 走学习
回路 → 出现验证问题时模拟学习者在对话内作答 → 导师提出系统判定后，运行器在对话外
执行固定 post-test 并按概念清单打分，以该分数确认（resolved/partial/unresolved）→
on-call 未解决则发"换种讲法"继续（宿主限 3 轮），one-shot 直接终局。导师若停在闲聊，
运行器最多补一次提醒；无进展两次即记 stalled，从未开 incident 记 no_incident——这些
都如实进入报告，不折叠进成功里。

## 结果状态（2026-08-25）

结果对比（on-call vs 基线的解决率、轮数、升级率）**已搁置**，等待真实学习者。三个依次
发现的仪器失效——正则判分惩罚复述且偏向多轮臂、按实质判分后两臂同触天花板、persona
在宿主强制状态下仍无法"学不会"——完整证据与后续研究设计见 [EVAL_LESSONS.md](EVAL_LESSONS.md)。
早期跑次的数字（含一度成立的"交叉"叙事）由此作废，仅存档于本地 `data/eval-runs/`，
不得引用。

在截至 2026-08-25 的**旧协议历史 cohort 内**，诊断准确率仍是可复查的描述性测量：剧本写死的
误概念是标准答案，不依赖模拟学习者的演技。对全部 176 个开了 incident 的存档评测会话：
**首次诊断与剧本误概念一致 166/176（94%）**，至少落在正确区域 99%（概念误解 100%、
计划缺口 98%、反馈不确定性 85%）。`9e8a75f` 改变了诊断 prompt/schema，题库也已从 27 题
扩到 31 题，因此这组数字不代表当前 HEAD。历史报告保存在本地
`data/eval-runs/diagnosis-accuracy.md`；当时没有冻结 176-session manifest，而当前 dry run 已能发现更多
存档会话，所以今天重新执行脚本不会精确复现同一个分母。先用
`node scripts/learning-diagnosis-accuracy.mjs --dry-run` 审计发现范围；新协议结果必须按 fingerprint
隔离目录后再判分。

回路可靠性单独记账：177 个存档会话中 6.2% 中途停滞、出错或从未开 incident
（on-call 7.9%，one-shot 4.5%）——机器越多，可失效点越多，这个数字必须与任何有效性
数字并列出现。
