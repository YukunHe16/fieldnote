import { describe, expect, it } from "vitest";
import { parseAskUserQuestionInput } from "../src/ask-user-question.js";

describe("AskUserQuestion parser", () => {
  it("keeps Claude Code's native questions and drops incomplete ones", () => {
    expect(
      parseAskUserQuestionInput({
        questions: [
          {
            header: "Format",
            question: "Which output format should I use?",
            options: [
              { label: "Markdown", description: "Write a document" },
              { label: "JSON", description: "Machine-readable" }
            ],
            multiSelect: false
          },
          { question: "Keep a single choice?", options: [{ label: "Yes" }] },
          { question: "What should I call you?", options: [] }
        ]
      })
    ).toEqual({
      questions: [
        {
          header: "Format",
          question: "Which output format should I use?",
          options: [
            { label: "Markdown", description: "Write a document" },
            { label: "JSON", description: "Machine-readable" }
          ]
        },
        {
          question: "Keep a single choice?",
          options: [{ label: "Yes" }]
        },
        {
          question: "What should I call you?",
          options: []
        }
      ]
    });
    expect(
      parseAskUserQuestionInput({
        questions: [
          {
            question: "Pick every school you want",
            options: [{ label: "MIT" }, { label: "Other", freeForm: true }],
            multiSelect: true
          }
        ]
      })
    ).toEqual({
      questions: [
        {
          question: "Pick every school you want",
          options: [{ label: "MIT" }, { label: "Other", freeForm: true }],
          multiSelect: true
        }
      ]
    });
    expect(parseAskUserQuestionInput({})).toBeNull();
  });
});
