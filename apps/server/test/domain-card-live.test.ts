import { describe, expect, it } from "vitest";
import { AdmissionsStore } from "../src/admissions-store.js";
import { openDatabase } from "../src/database.js";
import { domainCardDiff, LiveDomainCard } from "../src/domain-card-live.js";
import { MemoryStore } from "../src/memory-store.js";

describe("live domain card", () => {
  it("records a patch when a deadline line changes", () => {
    expect(domainCardDiff(["截止：5/1"], ["截止：4/15"])).toEqual(["+ 截止：4/15", "- 截止：5/1"]);
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);
    const admissions = new AdmissionsStore(database);
    const live = new LiveDomainCard(database);
    const cycle = admissions.createCycle({
      name: "2027 秋季",
      degree: "PhD",
      fieldOfStudy: "AI",
      intakeTerm: "Fall 2027",
      targetRegions: ["美国"],
      active: true
    });
    admissions.createProgram({
      cycleId: cycle.id,
      school: "MIT",
      program: "EECS",
      country: "美国",
      degree: "PhD",
      status: "applying",
      officialUrl: "https://example.edu",
      applicationFee: null,
      feeCurrency: null,
      fundingSummary: "",
      lastVerifiedAt: null,
      deadlineAt: "2026-12-01"
    });
    const first = live.capture("graduate-admissions", memories.stableContext("graduate-admissions"), admissions);
    expect(first?.lines.some((line) => line.includes("2026-12-01"))).toBe(true);
    admissions.updateProgram(admissions.listPrograms(cycle.id)[0]!.id, { deadlineAt: "2026-11-01" });
    const second = live.capture("graduate-admissions", memories.stableContext("graduate-admissions"), admissions);
    expect(second?.patch).toContain("2026-11-01");
    expect(live.digest("graduate-admissions").diff).toContain("+");
    database.close();
  });
});
