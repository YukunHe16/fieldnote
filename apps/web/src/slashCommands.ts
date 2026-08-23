import { t } from "./i18n";

export type SlashCommandId = "new" | "archive";

export interface SlashCommandDefinition {
  id: SlashCommandId;
  command: string;
  label: string;
  description: string;
  keywords: string[];
}

export function slashCommands(): SlashCommandDefinition[] {
  return [
    {
      id: "new",
      command: "/new",
      label: t("slashNew"),
      description: t("slashNewHint"),
      keywords: ["新建", "创建", "对话", "new", "create", "chat"]
    },
    {
      id: "archive",
      command: "/archive",
      label: t("slashArchive"),
      description: t("slashArchiveHint"),
      keywords: ["归档", "隐藏", "对话", "archive", "hide"]
    }
  ];
}

export function slashQuery(value: string) {
  const trimmed = value.trimStart();
  return trimmed.startsWith("/") ? trimmed.slice(1).trim().toLowerCase() : undefined;
}

export function matchSlashCommands(value: string) {
  const query = slashQuery(value);
  const commands = slashCommands();
  if (query === undefined) return [];
  if (!query) return commands;
  return commands.filter((command) =>
    [command.command.slice(1), command.label, command.description, ...command.keywords].some((part) =>
      part.toLowerCase().includes(query)
    )
  );
}
