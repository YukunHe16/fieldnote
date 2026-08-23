import type { DomainCardDto, MemoryItemDto } from "@fieldnote/contracts";
import type { AdmissionsStore } from "./admissions-store.js";

export interface DomainCardAdapter {
  profileId: string;
  build(input: { memories: MemoryItemDto[] }): DomainCardDto | null;
}

export function buildDomainCard(
  profileId: string,
  memories: MemoryItemDto[],
  admissions?: AdmissionsStore
): DomainCardDto | null {
  if (profileId === "graduate-admissions") {
    return new AdmissionsDomainCard(admissions).build({ memories });
  }
  return null;
}

class AdmissionsDomainCard implements DomainCardAdapter {
  readonly profileId = "graduate-admissions";

  constructor(private readonly admissions?: AdmissionsStore) {}

  build(input: { memories: MemoryItemDto[] }): DomainCardDto {
    const lines: string[] = [];
    const facts = input.memories.filter(
      (item) => item.category === "profile" || item.category === "goal" || item.category === "preference"
    );
    for (const memory of facts.slice(0, 8)) {
      lines.push(`${memory.title}：${memory.content}`);
    }
    const cycle = this.admissions?.listCycles().find((item) => item.active) ?? this.admissions?.listCycles()[0];
    if (cycle) {
      const profile = this.admissions?.getApplicantProfile(cycle.id);
      const programs = this.admissions?.listPrograms(cycle.id) ?? [];
      if (cycle.degree || cycle.fieldOfStudy) {
        lines.push(`申请目标：${[cycle.degree, cycle.fieldOfStudy, cycle.intakeTerm].filter(Boolean).join(" / ")}`);
      }
      if (cycle.targetRegions.length > 0) lines.push(`目标地区：${cycle.targetRegions.join("、")}`);
      if (profile?.educationSummary) lines.push(`教育背景：${profile.educationSummary}`);
      if (profile?.researchSummary) lines.push(`研究经历：${profile.researchSummary}`);
      if (profile?.budgetConstraints) lines.push(`预算约束：${profile.budgetConstraints}`);
      if (programs.length > 0) {
        const stage = dominantStage(programs.map((item) => item.status));
        lines.push(`当前阶段：${stage} · ${programs.length} 个项目`);
        for (const program of programs.slice(0, 4)) {
          const due = program.deadlines[0]?.dueAt ?? program.deadlineAt;
          if (due) {
            const date = due.slice(0, 10);
            lines.push(`${program.school} ${program.program} 截止：${date}`);
          }
        }
      }
    }
    const unique = [...new Set(lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 12);
    return {
      profileId: this.profileId,
      title: "申请人作战卡",
      lines: unique
    };
  }
}

function dominantStage(statuses: string[]): string {
  const rank = ["interview", "applying", "shortlisted", "researching", "submitted"];
  for (const status of rank) {
    if (statuses.includes(status)) return status;
  }
  return statuses[0] ?? "researching";
}
