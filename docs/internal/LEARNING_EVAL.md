# 学习回路离线评测设计（Learning Eval）

评测回答一个问题：**同一批带误解的学习场景，自适应回路（on-call）与一次性反馈基线（one-shot）在
解决率、干预轮数、升级率上表现如何？** 这是三位 computing-education 方向教授的候选 RQ
（"X compared with one-shot feedback"）的离线预演。

## 组成

- 题目：`apps/server/eval/learning-items/*.json`，12 题 × 3 个 difficulty 家族。
- 运行器：`scripts/learning-eval.mjs`，驱动本地运行中的服务的公开 HTTP API；
  学习会话使用 `datasetKind=eval`（策略固定默认顺序、不写经验、不产策略修订，保证题目间独立）。
- 模拟学习者：一个便宜模型按题目 persona 扮演学生；宿主概念清单为最终判定的依据。
- 产出：`data/eval-runs/<ts>/results.json` + `report.md`；服务端聚合可看
  `GET /api/learning/metrics?datasetKind=eval`。

```bash
node scripts/learning-eval.mjs --dry-run     # 校验题目与计划
node scripts/learning-eval.mjs               # 全量 12 题 × 2 条件
node scripts/learning-eval.mjs --items pg-sum-nested --conditions on-call
```

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

### planning_gap（4 题）— 递归/列表处理的计划缺失

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

### feedback_uncertainty（4 题）— EiPE 式作答与冲突/含错评分

对准 LLM grading reliability / 学生对错误反馈的接受度。EiPE（Explain in Plain English）
要求目的层描述而非逐行复述，是该系列工作的核心 rubric 区分；自动评分会犯错，
学生如何对待与自己一致/不一致、听起来权威/朴素的反馈是研究对象。

- Fowler et al., [Autograding "Explain in Plain English" questions using NLP](https://zilles.cs.illinois.edu/papers/fowler_EiPE_NLP_SIGCSE_2021.pdf) (SIGCSE '21)。
- [Code Generation Based Grading for EiPE](https://arxiv.org/html/2311.14903)；[SIGCSE '24 版本](https://doi.org/10.1145/3626253.3635542)。
- [Evaluating AI Models for Autograding EiPE Questions](https://dl.acm.org/doi/10.1145/3774752) (ACM TiiS)。

题目自带 ground truth（哪份评分有证据支持）：逐行复述 vs 目的层（fu-eipe-max，B 对）、
错误答案被宽松评分器放行（fu-eipe-swap，A 对——测"接受错误正面反馈"）、二分查找死循环的
奇偶红鲱鱼（fu-binary-search-loop，B 对）、权威口吻的错误复杂度反馈（fu-complexity-triangle，
学生原答案对——测"在权威压力下放弃正确答案"）。

### conceptual_misconception（4 题）— cache 存储层级的 3C 误解

对准 Computer Architecture 教学与可验证练习。3C 模型（compulsory/conflict/capacity，
Hennessy & Patterson 标准教材框架）中 conflict miss 的成因最难理解，是教学模拟器文献
反复处理的对象。

- [3C 模型参考](http://thebeardsage.com/cache-misses-the-three-cs/)；教学困难背景：
  [An execution-driven simulation tool for teaching cache memories](https://www.academia.edu/19683161)。

题目：空 cache 被叫"满"（cm-conflict-not-capacity）、冷启动一切皆 compulsory
（cm-compulsory-inflation）、关联度万能论的 LRU 循环反例（cm-associativity-limits）、
write-back 每次写都到内存（cm-write-policy）。每题的访问序列都可由宿主确定性模拟出
标准答案——这也是后续"可验证出题器"对位件（Mariana 方向）的种子。

## 题目 schema

```jsonc
{
  "id": "pg-sum-nested",
  "difficultyType": "planning_gap",        // 6 类之一
  "topicKey": "programming-plans",         // eval 数据集内的主题分组
  "title": "…",
  "opening": "学习者的第一条消息（含代码/错误信念）",
  "groundTruth": "仅 fu 家族：哪份反馈有证据支持",
  "persona": {
    "beliefs": ["初始错误信念…"],
    "style": "作答风格与顽固度",
    "unlockConcepts": ["解锁概念 id…"]      // 导师讲到才允许改口
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
