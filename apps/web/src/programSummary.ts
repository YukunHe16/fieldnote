const REQUIREMENT_MARK =
  /GRE|GMAT|TOEFL|IELTS|LSAT|GPA|推荐信|成绩单|语言成绩|考试要求|无\s*GRE|文书|SOP|CV|简历|作品集|portfolio/i;

export function splitProgramSummary(text?: string | null): { overview: string[]; requirements: string[] } {
  const overview: string[] = [];
  const requirements: string[] = [];
  for (const part of String(text ?? "").split(/[。！？!?\n]+/)) {
    const item = part.trim();
    if (!item) continue;
    if (REQUIREMENT_MARK.test(item)) requirements.push(item);
    else overview.push(item);
  }
  return { overview, requirements };
}
