import { useState } from "react";
import { useLocale } from "../i18n";
import { Icon } from "../icons";

const COMMANDS = ["npx fieldnote", "pnpm dev"];

export function ConnectionScreen() {
  const { t } = useLocale();
  const [copied, setCopied] = useState<string>();

  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      window.setTimeout(() => setCopied((current) => (current === command ? undefined : current)), 1600);
    } catch {
      setCopied(undefined);
    }
  }

  return (
    <section className="connection-screen" role="status" aria-live="polite">
      <div className="connection-card">
        <span className="connection-glyph" aria-hidden="true">
          <Icon name="brand" size={26} />
        </span>
        <h1>{t("connectionTitle")}</h1>
        <p>{t("connectionBody")}</p>

        <div className="connection-commands">
          <p className="connection-commands-label">{t("connectionCommandLabel")}</p>
          {COMMANDS.map((command) => (
            <div className="connection-command" key={command}>
              <code>{command}</code>
              <button type="button" onClick={() => void copy(command)} aria-label={`${t("copyCommand")} ${command}`}>
                <Icon name={copied === command ? "check" : "copy"} size={14} />
                {copied === command ? t("copied") : t("copy")}
              </button>
            </div>
          ))}
        </div>

        <p className="connection-retry">
          <i className="connection-spinner" aria-hidden="true" />
          {t("connectionRetrying")}
        </p>
        <small className="connection-doctor">{t("connectionDoctorHint")}</small>
      </div>
    </section>
  );
}
