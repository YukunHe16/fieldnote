import type { AskUserQuestionDto, AskUserQuestionItemDto } from "@fieldnote/contracts";

export function parseAskUserQuestionInput(input: unknown): AskUserQuestionDto | null {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const questions = Array.isArray(raw.questions) ? raw.questions.flatMap((item) => parseQuestion(item) ?? []) : [];
  return questions.length > 0 ? { questions } : null;
}

function parseQuestion(input: unknown): AskUserQuestionItemDto | null {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option) => {
        const value = option && typeof option === "object" ? (option as Record<string, unknown>) : {};
        const label = typeof value.label === "string" ? value.label.trim() : "";
        if (!label) return [];
        return [
          {
            label,
            ...(typeof value.description === "string" && value.description.trim()
              ? { description: value.description.trim() }
              : {}),
            ...(typeof value.preview === "string" && value.preview.trim() ? { preview: value.preview.trim() } : {}),
            ...(value.freeForm === true || value.free_form === true ? { freeForm: true } : {})
          }
        ];
      })
    : [];
  if (!question) return null;
  return {
    question,
    ...(typeof raw.header === "string" && raw.header.trim() ? { header: raw.header.trim() } : {}),
    options,
    ...(raw.multiSelect === true || raw.multi_select === true ? { multiSelect: true } : {})
  };
}
