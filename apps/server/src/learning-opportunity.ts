export interface LearningOpportunityMessage {
  role: "user" | "assistant" | "system" | string;
  content: string;
}

export interface LearningOpportunity {
  goal: string;
  reason: string;
  confidence: number;
}

const BLOCKED_TASK =
  /(写(一封|个|份|邮件|文书|报告|简历)|润色|改写|翻译|生成|总结|检索|调研|研究|查资料|查学校|查一下|申请|提交|预约|填(写|表)|整理|导出|安排|邮件|deadline|resume|cover letter|translate|write (an |a )?(email|report|essay)|generate|summari[sz]e|research|search|schedule|administrative)/i;
const EXPLICIT_CONFUSION =
  /(不懂|没(有)?理解|没明白|学不会|搞不懂|困惑|卡住|换(一?种)?讲法|教教我|教我|讲解|解释|帮我理解|i (do not|don't) understand|i am confused|teach me|help me understand|explain (this|it|to me)|how does|how do|why does|why do|why is|why are)/i;
const EDUCATION_INTENT =
  /(学习|理解|讲解|解释|教我|练习|推导|概念|原理|算法|代码为什么|how|why|explain|understand|learn|teach|concept|algorithm|recursion)/i;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function visibleRecent(messages: LearningOpportunityMessage[]): LearningOpportunityMessage[] {
  return messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && clean(message.content))
    .slice(-6);
}

/**
 * A conservative, deterministic suggestion detector. It does not create a session;
 * callers must still let the user accept or dismiss the suggestion.
 */
export function detectLearningOpportunity(messages: LearningOpportunityMessage[]): LearningOpportunity | null {
  const recent = visibleRecent(messages);
  const userMessages = recent.filter((message) => message.role === "user");
  const latestUser = userMessages.at(-1);
  if (!latestUser) return null;
  const latestText = clean(latestUser.content);
  if (!latestText || BLOCKED_TASK.test(latestText) || (latestText.length < 4 && !EXPLICIT_CONFUSION.test(latestText)))
    return null;
  const latestLearningRequest = [...userMessages]
    .reverse()
    .find(
      (message) =>
        (EXPLICIT_CONFUSION.test(message.content) || EDUCATION_INTENT.test(message.content)) &&
        !BLOCKED_TASK.test(message.content)
    );

  const explicit = [...userMessages]
    .reverse()
    .find((message) => EXPLICIT_CONFUSION.test(message.content) && !BLOCKED_TASK.test(message.content));
  if (explicit) {
    return {
      goal: clean((latestLearningRequest ?? explicit).content),
      reason: "检测到你明确表示理解困难，建议开启学习模式继续追踪。",
      confidence: 0.82
    };
  }

  const lastTwoUsers = userMessages.slice(-2);
  if (
    lastTwoUsers.length === 2 &&
    lastTwoUsers.every((message) => EDUCATION_INTENT.test(message.content) && !BLOCKED_TASK.test(message.content))
  ) {
    return {
      goal: clean(lastTwoUsers[1]!.content),
      reason: "你连续提出了学习与理解相关的问题，建议开启学习模式。",
      confidence: 0.76
    };
  }
  return null;
}
