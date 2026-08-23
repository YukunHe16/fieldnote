import type { HandbookDocumentDto, PlaybookDto, PlaybookOrigin, PlaybookPolarity } from "@fieldnote/contracts";
import { preparePlaybookInstruction, type CreatePlaybookInput } from "./evolution-store.js";

const linePattern = /^-\s*\[(do|dont)\](?:\[(off|user|confirmed|distilled)\])?\s+(.+)$/i;

export function renderHandbook(title: string, playbooks: PlaybookDto[]): string {
  const lines = playbooks.map((item) => {
    const flags = [item.polarity, item.enabled ? (item.origin === "user" ? null : item.origin) : "off"].filter(Boolean);
    return `- [${flags.join("][")}] ${item.instruction}`;
  });
  return [`# ${title}`, "", ...lines, ""].join("\n");
}

export function parseHandbook(
  markdown: string,
  fallbackOrigin: PlaybookOrigin = "user"
): { items: Array<Omit<CreatePlaybookInput, "profileId" | "scope">>; errors: string[] } {
  const items: Array<Omit<CreatePlaybookInput, "profileId" | "scope">> = [];
  const errors: string[] = [];
  for (const [index, raw] of markdown.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(linePattern);
    if (!match) {
      errors.push(`第 ${index + 1} 行无法解析：${line}`);
      continue;
    }
    const polarity = match[1]!.toLowerCase() as PlaybookPolarity;
    const flag = match[2]?.toLowerCase();
    const instruction = preparePlaybookInstruction(match[3] ?? "");
    if (!instruction) {
      errors.push(`第 ${index + 1} 行缺少做法说明，或只剩下不安全的指令腔`);
      continue;
    }
    items.push({
      title: instruction.slice(0, 80),
      instruction,
      polarity,
      origin: flag === "confirmed" || flag === "distilled" || flag === "user" ? flag : fallbackOrigin,
      enabled: flag !== "off"
    });
  }
  return { items, errors };
}

export function handbookDocument(
  title: string,
  profileId: string | null,
  playbooks: PlaybookDto[]
): HandbookDocumentDto {
  return {
    profileId,
    markdown: renderHandbook(title, playbooks),
    playbooks
  };
}
