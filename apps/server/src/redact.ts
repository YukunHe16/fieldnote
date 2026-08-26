import { containsSensitiveContent } from "./memory-store.js";

/**
 * Best-effort redaction for text that leaves its original conversation — scheduled report
 * context and the anonymized research export. Content matching the memory store's sensitive
 * patterns is dropped wholesale; the rest is scrubbed for keys, ids and contact details.
 */
const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

export function redactSensitiveText(content: string): string {
  if (containsSensitiveContent(content)) return "[内容因可能包含敏感信息已省略]";
  // Join keys must survive redaction: a UUID's digit-and-hyphen runs otherwise match the
  // phone/id patterns below, and one mangled sessionId breaks every cross-table reference
  // in the research export (observed live: "…bf[REDACTED_PHONE]b23").
  const uuids: string[] = [];
  const shielded = content.replace(UUID_PATTERN, (match) => {
    uuids.push(match);
    return `\u0000u${uuids.length - 1}\u0000`;
  });
  const redacted = shielded
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_ -]?key|password|passport(?:\s*number)?|bank\s*account)\s*[:：]\s*\S+/gi, "$1: [REDACTED]")
    .replace(/\b\d{6,17}[0-9Xx]\b/g, "[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/(?:\+?\d[\d\s()-]{8,}\d)/g, "[REDACTED_PHONE]");
  return redacted.replace(/\u0000u(\d+)\u0000/g, (_match, index) => uuids[Number(index)] ?? "");
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
