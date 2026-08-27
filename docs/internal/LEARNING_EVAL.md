# 学习回路离线评测设计（Learning Eval）

评测回答一个问题：**同一批带误解的学习场景，自适应回路（on-call）与基线条件相比表现如何？**
基线有两个：`multi-turn`（与 on-call 同样的三轮预算，但没有策略推荐、不禁止重复已失败的
策略、不能升级——把"结构"从"多聊了几轮"里隔离出来，默认对比项）与 `one-shot`（单轮反馈，
回答更窄的问题）。这是 computing-education 方向候选 RQ 的离线预演。

> **2026-08-25 状态**：结果对比（解决率等）已搁置——LLM 模拟学习者无法可信地"学不会"，
> 详见 [EVAL_LESSONS.md](EVAL_LESSONS.md)；诊断准确率仍然有效并已测量（见文末）。

## 组成

- 题目：`apps/server/eval/learning-items/*.json`，27 题 × 3 个 difficulty 家族（pg 6 · cm 6 · fu 15）；每题的出口检查带一个迁移任务（fresh case），概念清单附 judge 用的 `credit` 判分说明。结构不变量由 `apps/server/test/eval-items.test.ts` 在 CI 里守着——题库是评测的判分依据，写错不会报错，只会静默算错分。
- 运行器：`scripts/learning-eval.mjs`，驱动本地运行中的服务的公开 HTTP API；
  学习会话使用 `datasetKind=eval`（策略固定默认顺序、不写经验、不产策略修订，保证题目间独立）。
- 模拟学习者：一个便宜模型按题目 persona 扮演学生；stubborn 层的"是否已巩固"由运行器
  按剧本条件判定后注入 persona，不留给模型自己推断。
- 判分：judge（temperature 0）按概念清单评实质，正则清单作为每次判分随行记录的第二意见，
  报告写明两者一致率；同时报末轮与最优两种覆盖读数。
- 产出：`data/eval-runs/<ts>/results.json` + `report.md`；服务端聚合可看
  `GET /api/learning/metrics?datasetKind=eval`。

```bash
node scripts/learning-eval.mjs --dry-run     # 校验题目与计划
node scripts/learning-eval.mjs               # 全量 27 题 × 2 条件（on-call vs multi-turn）
node scripts/learning-eval.mjs --items pg-sum-nested --conditions on-call
```

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

## 方法边界（对外表述必须带上）

1. **模拟学习者不是学生。** persona 是"概念门控"式脚本：只有当导师明确讲到解锁概念时才改口。
   结果说明回路在模拟下的行为差异，不能推断真实学习效果。
2. **判定是确定性的，且量尺跨条件一致。** 导师每次提出系统判定后，运行器把题目自带的
   **固定 post-test（出口自解释题）**直接问模拟学习者（不进入导师对话），再用概念正则清单
   对该回答打分（全中 resolved / 部分 partial / 全空 unresolved）。两个条件用同一把尺子，
   不受导师自拟验证题形态的影响；系统判定与最终判定分开保存，正好用于校准分析。
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

### feedback_uncertainty（15 题）— EiPE 式作答与冲突/含错评分

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

**因子矩阵与对照组。** 15 题（9 轻信 + 6 对照）按三个二值因子铺满 8 格：本格所描述的
那份反馈（`focalGrader`）**是否错** × 它**肯定还是否定**学习者 × 语气**朴素还是权威**。
`sound-*` 那半边是对照——那里 focal 的反馈其实是**对的**，而 persona 的信念恰恰在推着
学习者去推开它。没有这半边，指标分不清"轻信"和"一律不信"：一个把所有反馈都拒掉的
学习者在轻信那半边会得到和恰当怀疑的学习者一样漂亮的成绩。

判定来自 `groundTruth.acceptanceConcept`（正确结论）在出口检查里**缺席**：缺席 = 学习者
最终**站到了没有证据支持的那一边**；未作答记为 null，不计入。注意这一个量在两半边是
**两种相反的错误**——`wrong-*` 半边是轻信（顺着错的走），`sound-*` 半边是过度拒斥
（把对的推开）。`scripts/learning-eval.mjs` 因此按格报告并**分半边汇总**，绝不合并成
单一"接受率"：合并会把"一律不信"读成好判断。

**单信念 vs 双信念（一个刻意保留的分组）。** 最早 6 题每题脚本了**两个**信念——一个关于
学科内容、一个关于信谁——而 tutor 稳定地诊断出其中一个、漏掉另一个,judge 按整个信念列表
打分于是判 partial。这正是本家族诊断准确率最低（85%，50/59，全部 8 条 partial 都在这里）
的结构性原因，而 cm/pg 是单信念家族，分别 100% / 98%。后加的 9 题只脚本"信谁"这一条，
学习者开场的错答是情境事实而非会去辩护的立场。**两组刻意不混**：如果单信念组的诊断准确率
明显更高，上面那个结构性解释就得到了验证。注意这**不是**改评分口径——166/176（94%）
那个数字的计算方式没有动，仍然可比。

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

仍然有效的测量是**诊断准确率**：剧本写死的误概念是标准答案，不依赖模拟学习者的演技。
对全部 176 个开了 incident 的存档评测会话：**首次诊断与剧本误概念一致 166/176（94%）**，
至少落在正确区域 99%（概念误解 100%、计划缺口 98%、反馈不确定性 85%）。复现：
`node scripts/learning-diagnosis-accuracy.mjs`。

回路可靠性单独记账：177 个存档会话中 6.2% 中途停滞、出错或从未开 incident
（on-call 7.9%，one-shot 4.5%）——机器越多，可失效点越多，这个数字必须与任何有效性
数字并列出现。
