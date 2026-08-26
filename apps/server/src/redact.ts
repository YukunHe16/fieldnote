import { containsSensitiveContent } from "./memory-store.js";

/**
 * Structural values that must survive redaction untouched. Both are runs of digits and
 * separators, so the phone/id rules below would otherwise shred them:
 *  - UUIDs are the export's join keys; one mangled sessionId breaks every cross-table
 *    reference (observed live: "…bf[REDACTED_PHONE]b23").
 *  - ISO timestamps are the export's time axis; "2026-08-25" matched the phone rule, so
 *    every createdAt in the research export was arriving as "[REDACTED_PHONE]T06:11:40Z".
 * Neither is personal information, and analysis is impossible without them.
 */
const STRUCTURAL_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

/**
 * Best-effort redaction for text that leaves its original conversation — scheduled report
 * context and the anonymized research export. Content matching the memory store's sensitive
 * patterns is dropped wholesale; the rest is scrubbed for keys, ids and contact details.
 */
export function redactSensitiveText(content: string): string {
  if (containsSensitiveContent(content)) return "[内容因可能包含敏感信息已省略]";
  const shields: string[] = [];
  const shielded = content.replace(STRUCTURAL_PATTERN, (match) => {
    shields.push(match);
    return `\u0000u${shields.length - 1}\u0000`;
  });
  const redacted = shielded
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_ -]?key|password|passport(?:\s*number)?|bank\s*account)\s*[:：]\s*\S+/gi, "$1: [REDACTED]")
    .replace(/\b\d{6,17}[0-9Xx]\b/g, "[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/(?:\+?\d[\d\s()-]{8,}\d)/g, "[REDACTED_PHONE]");
  return redacted.replace(/\u0000u(\d+)\u0000/g, (_match, index) => shields[Number(index)] ?? "");
}

/** Apply redactSensitiveText to every string in a JSON-shaped value, keys included left as-is. */
export function deepRedact<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => deepRedact(item)) as unknown as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = deepRedact(item);
    return result as unknown as T;
  }
  return value;
}
