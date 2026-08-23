import { describe, expect, it } from "vitest";
import { AdmissionsStore, cleanArtifactRelativePath } from "../src/admissions-store.js";
import { openDatabase } from "../src/database.js";

const day = 24 * 60 * 60_000;
const now = Date.UTC(2026, 7, 18, 0, 0, 0);

function fixture() {
  const database = openDatabase(":memory:");
  let current = now;
  const store = new AdmissionsStore(database, () => current);
  const cycle = store.createCycle({
    name: "2027 Fall CS",
    degree: "PhD",
    fieldOfStudy: "Computer Science",
    intakeTerm: "Fall 2027",
    targetRegions: ["US", "Canada"],
    active: true
  });
  return {
    database,
    store,
    cycle,
    advance: (milliseconds: number) => {
      current += milliseconds;
    }
  };
}

describe("AdmissionsStore", () => {
  it("keeps a cycle's profile, programs, requirements, tasks, sources, and artifacts connected", () => {
    const { database, store, cycle } = fixture();
    const profile = store.createApplicantProfile({
      cycleId: cycle.id,
      educationSummary: "BSc",
      researchSummary: "NLP",
      exams: { TOEFL: 110 },
      budgetConstraints: "funding required"
    });
    const source = store.createSource({
      cycleId: cycle.id,
      url: "https://grad.example.edu",
      publisher: "Example Graduate School",
      snippet: "Deadline",
      contentHash: "sha256:one",
      verifiedAt: now,
      fetchedAt: now
    });
    const program = store.createProgram({
      cycleId: cycle.id,
      school: "Example University",
      program: "Computer Science",
      country: "US",
      degree: "PhD",
      status: "researching",
      officialUrl: source.url,
      applicationFee: 95,
      feeCurrency: "USD",
      deadlineAt: now + 20 * day,
      fundingSummary: "Funding listed",
      lastVerifiedAt: now
    });
    const requirement = store.createRequirement({
      programId: program.id,
      type: "statement",
      label: "Statement of Purpose",
      status: "missing",
      dueAt: now + 15 * day,
      notes: "1000 words",
      sourceId: source.id
    });
    const task = store.createTask({
      cycleId: cycle.id,
      programId: program.id,
      title: "Request transcript",
      priority: "high",
      dueAt: now + 5 * day,
      completed: false
    });
    const artifact = store.createArtifact({
      cycleId: cycle.id,
      programId: program.id,
      type: "SOP",
      version: 1,
      fileName: "sop-v1.docx",
      relativePath: "admissions/2027/sop-v1.docx"
    });
    store.linkSource({ sourceId: source.id, targetType: "program", targetId: program.id, fieldName: "deadlineAt" });

    expect(store.getApplicantProfile(cycle.id)).toMatchObject({ id: profile.id, exams: { TOEFL: 110 } });
    expect(store.listPrograms(cycle.id)).toMatchObject([{ id: program.id, status: "researching" }]);
    expect(store.listRequirements(program.id)).toMatchObject([{ id: requirement.id, sourceId: source.id }]);
    expect(store.listTasks(cycle.id)).toMatchObject([{ id: task.id, programId: program.id }]);
    expect(store.listArtifacts(cycle.id)).toMatchObject([
      { id: artifact.id, relativePath: "admissions/2027/sop-v1.docx" }
    ]);
    expect(store.listSourceLinks("program", program.id)).toEqual([
      { sourceId: source.id, targetType: "program", targetId: program.id, fieldName: "deadlineAt" }
    ]);

    expect(store.deleteCycle(cycle.id)).toBe(true);
    expect(store.getApplicantProfile(cycle.id)).toBeNull();
    expect(store.getProgram(program.id)).toBeNull();
    expect(store.getRequirement(requirement.id)).toBeNull();
    expect(store.getTask(task.id)).toBeNull();
    expect(store.getSource(source.id)).toBeNull();
    expect(store.getArtifact(artifact.id)).toBeNull();
    database.close();
  });

  it("enforces application states and same-cycle links", () => {
    const { database, store, cycle } = fixture();
    expect(() =>
      store.createProgram({
        cycleId: cycle.id,
        school: "U",
        program: "CS",
        country: "US",
        degree: "MS",
        status: "maybe" as "researching",
        officialUrl: "",
        applicationFee: null,
        feeCurrency: null,
        deadlineAt: null,
        fundingSummary: "",
        lastVerifiedAt: null
      })
    ).toThrow(/program status/);
    const other = store.createCycle({
      name: "Other",
      degree: "MS",
      fieldOfStudy: "Math",
      intakeTerm: "2027",
      targetRegions: ["Hong Kong"],
      active: true
    });
    const source = store.createSource({
      cycleId: other.id,
      url: "https://other.example",
      publisher: "Other",
      snippet: "",
      contentHash: "hash",
      verifiedAt: now,
      fetchedAt: now
    });
    const program = store.createProgram({
      cycleId: cycle.id,
      school: "U",
      program: "CS",
      country: "US",
      degree: "MS",
      status: "researching",
      officialUrl: "",
      applicationFee: null,
      feeCurrency: null,
      deadlineAt: null,
      fundingSummary: "",
      lastVerifiedAt: null
    });
    expect(() =>
      store.createRequirement({
        programId: program.id,
        type: "cv",
        label: "CV",
        status: "missing",
        dueAt: null,
        notes: "",
        sourceId: source.id
      })
    ).toThrow(/program cycle/);
    expect(() =>
      store.createTask({
        cycleId: other.id,
        programId: program.id,
        title: "wrong",
        priority: "high",
        dueAt: null,
        completed: false
      })
    ).toThrow(/belong to the application cycle/);
    database.close();
  });

  it("returns only the weekly change window and daily 30-day incomplete deadlines", () => {
    const { database, store, cycle, advance } = fixture();
    const program = store.createProgram({
      cycleId: cycle.id,
      school: "University",
      program: "CS",
      country: "Canada",
      degree: "MSc",
      status: "applying",
      officialUrl: "https://example.edu",
      applicationFee: null,
      feeCurrency: null,
      deadlineAt: now + 10 * day,
      fundingSummary: "",
      lastVerifiedAt: now
    });
    const requirement = store.createRequirement({
      programId: program.id,
      type: "cv",
      label: "CV",
      status: "in_progress",
      dueAt: now + 3 * day,
      notes: "",
      sourceId: null
    });
    store.createRequirement({
      programId: program.id,
      type: "transcript",
      label: "Transcript",
      status: "submitted",
      dueAt: now + 2 * day,
      notes: "",
      sourceId: null
    });
    store.createTask({
      cycleId: cycle.id,
      programId: program.id,
      title: "Ask recommender",
      priority: "high",
      dueAt: now + 31 * day,
      completed: false
    });
    store.createTask({
      cycleId: cycle.id,
      programId: program.id,
      title: "Book test",
      priority: "medium",
      dueAt: now + 6 * day,
      completed: false
    });
    advance(8 * day);
    store.updateRequirement(requirement.id, { status: "ready" });

    const weekly = store.weeklyReview(cycle.id, now + 8 * day);
    expect(weekly.changes).toMatchObject([{ type: "requirement", id: requirement.id }]);
    expect(weekly.upcomingDeadlines).toMatchObject([{ type: "program", programId: program.id }]);
    expect(weekly.missingRequirements).toEqual([]);

    const daily = store.dailyPlan(cycle.id, now);
    expect(daily.deadlines.map((item) => item.type)).toEqual(["requirement", "task", "program"]);
    expect(daily.deadlines[2]).toMatchObject({ programId: program.id });
    expect(daily.deadlines.map((item) => item.title)).not.toContain("Ask recommender");
    expect(daily.missingRequirements).toEqual([]);
    expect(daily.openTasks).toHaveLength(2);
    database.close();
  });

  it("stores every published application round and keeps a single deadline as one round", () => {
    const { database, store, cycle } = fixture();
    const single = store.createProgram({
      cycleId: cycle.id,
      school: "Oxford",
      program: "CS",
      country: "UK",
      degree: "MSc",
      status: "researching",
      officialUrl: "",
      applicationFee: null,
      feeCurrency: null,
      deadlineAt: now + 12 * day,
      fundingSummary: "",
      lastVerifiedAt: null
    });
    expect(single.deadlines).toEqual([
      expect.objectContaining({ label: "", dueAt: new Date(now + 12 * day).toISOString() })
    ]);
    expect(single.deadlineAt).toBe(new Date(now + 12 * day).toISOString());

    const program = store.createProgram({
      cycleId: cycle.id,
      school: "CMU",
      program: "MIIS",
      country: "US",
      degree: "MS",
      status: "shortlisted",
      officialUrl: "https://example.edu",
      applicationFee: null,
      feeCurrency: null,
      deadlineAt: null,
      fundingSummary: "",
      lastVerifiedAt: now,
      deadlines: [
        { label: "Round 1", dueAt: now + 10 * day },
        { label: "Round 2", dueAt: now + 40 * day }
      ]
    });
    expect(program.deadlines.map((item) => item.label)).toEqual(["Round 1", "Round 2"]);
    expect(program.deadlineAt).toBe(new Date(now + 10 * day).toISOString());
    expect(
      store
        .dailyPlan(cycle.id, now)
        .deadlines.filter((item) => item.type === "program" && item.programId === program.id)
    ).toHaveLength(1);
    expect(store.dailyPlan(cycle.id, now + 20 * day).deadlines).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "CMU · MIIS · Round 2", programId: program.id })])
    );

    expect(store.updateProgram(program.id, { deadlineAt: now + 8 * day })?.deadlines.map((item) => item.label)).toEqual(
      ["Round 1", "Round 2"]
    );
    const replaced = store.updateProgram(program.id, { deadlines: [{ label: "Final", dueAt: now + 5 * day }] });
    expect(replaced?.deadlines).toEqual([expect.objectContaining({ label: "Final" })]);
    expect(replaced?.deadlineAt).toBe(new Date(now + 5 * day).toISOString());
    database.close();
  });

  it("stores artifacts as clean relative paths only", () => {
    const { database, store, cycle } = fixture();
    expect(cleanArtifactRelativePath("artifacts/sop-v1.pdf")).toBe("artifacts/sop-v1.pdf");
    for (const invalid of ["/tmp/sop.pdf", "../sop.pdf", "artifacts/../sop.pdf", "artifacts\\sop.pdf", ""]) {
      expect(() => cleanArtifactRelativePath(invalid)).toThrow(/clean relative path/);
    }
    expect(() =>
      store.createArtifact({
        cycleId: cycle.id,
        programId: null,
        type: "CV",
        version: 1,
        fileName: "cv.pdf",
        relativePath: "../cv.pdf"
      })
    ).toThrow(/clean relative path/);
    database.close();
  });
});
