import { describe, expect, it } from "vitest";
import { deepRedact, redactSensitiveText } from "../src/redact.js";

describe("redact", () => {
  it("scrubs contacts and long digit runs from free text", () => {
    const input = "Contact me at student@example.edu or +1 (217) 555-0100 tomorrow.";
    const output = redactSensitiveText(input);
    expect(output).not.toContain("student@example.edu");
    expect(output).not.toContain("555-0100");
    expect(output).toContain("[REDACTED_EMAIL]");
  });

  it("never lets an API key through, whether dropped wholesale or masked", () => {
    const output = redactSensitiveText("Key: sk-ant-abc123DEF please keep");
    expect(output).not.toContain("sk-ant-abc123DEF");
  });

  it("drops content matching the sensitive patterns wholesale", () => {
    expect(redactSensitiveText("我的银行卡号 6222020200112233445")).toBe("[内容因可能包含敏感信息已省略]");
  });

  it("walks nested export structures and leaves non-strings alone", () => {
    const redacted = deepRedact({
      count: 3,
      done: true,
      sessions: [{ goal: "写信给 someone@example.com", confidence: 0.8, tags: ["a@b.io"] }]
    });
    expect(redacted.count).toBe(3);
    expect(redacted.done).toBe(true);
    expect(redacted.sessions[0]?.confidence).toBe(0.8);
    expect(redacted.sessions[0]?.goal).toContain("[REDACTED_EMAIL]");
    expect(redacted.sessions[0]?.tags[0]).toBe("[REDACTED_EMAIL]");
  });
});
