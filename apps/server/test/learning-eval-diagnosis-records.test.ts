import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { captureDiagnosis, initialDiagnosisRecordFields } from "../../../scripts/learning-eval.mjs";
import { embeddedDiagnosis, partitionDiagnosisRecords } from "../../../scripts/learning-diagnosis-accuracy.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("learning eval diagnosis records", () => {
  it("initializes diagnosis fields to null and captures the latest non-superseded incident", () => {
    const record = initialDiagnosisRecordFields();
    expect(record).toEqual({
      incidentId: null,
      diagnosedDifficultyType: null,
      diagnosisHypothesis: null
    });

    captureDiagnosis(record, {
      incidents: [
        {
          id: "incident-old",
          difficultyType: "planning_gap",
          hypothesis: "old active diagnosis",
          supersededAt: null
        },
        {
          id: "incident-edited",
          difficultyType: "conceptual_misconception",
          hypothesis: "superseded diagnosis",
          supersededAt: "2026-08-27T00:00:00.000Z"
        },
        {
          id: "incident-latest",
          difficultyType: "feedback_uncertainty",
          hypothesis: "the learner trusts the authoritative grader",
          supersededAt: null
        }
      ]
    });

    expect(record).toEqual({
      incidentId: "incident-latest",
      diagnosedDifficultyType: "feedback_uncertainty",
      diagnosisHypothesis: "the learner trusts the authoritative grader"
    });
  });
});

describe("diagnosis audit record selection", () => {
  it("uses an embedded nonempty hypothesis without selecting the record for legacy lookup", () => {
    const record = {
      conversationId: "conversation-new",
      incidentId: "incident-new",
      diagnosedDifficultyType: "feedback_uncertainty",
      diagnosisHypothesis: "The learner accepts the grader without checking the rubric."
    };

    expect(embeddedDiagnosis(record)).toEqual({
      incidentId: "incident-new",
      diagnosedDifficultyType: "feedback_uncertainty",
      hypothesis: "The learner accepts the grader without checking the rubric."
    });
    expect(partitionDiagnosisRecords([record])).toEqual({ embedded: [record], legacy: [] });
  });

  it("audits an embedded-only results directory without a retained SQLite database", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fieldnote-embedded-diagnosis-"));
    cleanups.push(directory);
    const runDirectory = path.join(directory, "run");
    await fs.mkdir(runDirectory);
    await fs.writeFile(
      path.join(runDirectory, "results.json"),
      JSON.stringify({
        protocol: { fingerprint: "test-protocol" },
        records: [
          {
            conversationId: "conversation-new",
            itemId: "fu-eipe-max",
            family: "feedback_uncertainty",
            condition: "on-call",
            incidentId: "incident-new",
            diagnosedDifficultyType: "feedback_uncertainty",
            diagnosisHypothesis: "The learner assumes the grader must be right."
          }
        ]
      })
    );

    const output = execFileSync(
      process.execPath,
      [
        path.join(repo, "scripts/learning-diagnosis-accuracy.mjs"),
        "--runs",
        directory,
        "--db",
        path.join(directory, "missing.db"),
        "--dry-run"
      ],
      { cwd: repo, encoding: "utf8" }
    );
    expect(output).toContain("Diagnosis audit dry run: 1 diagnoses");
  });

  it("selects a legacy record for SQLite fallback", () => {
    const record = { conversationId: "conversation-legacy" };
    expect(partitionDiagnosisRecords([record])).toEqual({ embedded: [], legacy: [record] });
  });

  it("keeps legacy SQLite lookup working", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fieldnote-legacy-diagnosis-"));
    cleanups.push(directory);
    const runDirectory = path.join(directory, "run");
    const databasePath = path.join(directory, "agent.db");
    await fs.mkdir(runDirectory);
    await fs.writeFile(
      path.join(runDirectory, "results.json"),
      JSON.stringify({
        protocol: { fingerprint: "test-protocol" },
        records: [
          {
            conversationId: "conversation-legacy",
            itemId: "fu-eipe-max",
            family: "feedback_uncertainty",
            condition: "on-call"
          }
        ]
      })
    );
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE learning_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
      CREATE TABLE learning_incidents (session_id TEXT NOT NULL, hypothesis TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO learning_sessions (id, conversation_id) VALUES ('session-legacy', 'conversation-legacy');
      INSERT INTO learning_incidents (session_id, hypothesis, created_at)
      VALUES ('session-legacy', 'The learner assumes the grader must be right.', 1);
    `);
    database.close();

    const output = execFileSync(
      process.execPath,
      [
        path.join(repo, "scripts/learning-diagnosis-accuracy.mjs"),
        "--runs",
        directory,
        "--db",
        databasePath,
        "--dry-run"
      ],
      { cwd: repo, encoding: "utf8" }
    );
    expect(output).toContain("Diagnosis audit dry run: 1 diagnoses");
  });

  it("treats an empty embedded hypothesis as legacy", () => {
    const record = {
      conversationId: "conversation-empty",
      incidentId: "incident-empty",
      diagnosedDifficultyType: "feedback_uncertainty",
      diagnosisHypothesis: "   "
    };
    expect(embeddedDiagnosis(record)).toBeNull();
    expect(partitionDiagnosisRecords([record])).toEqual({ embedded: [], legacy: [record] });
  });
});
