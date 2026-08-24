import { useLocale } from "../i18n";
import { MODEL_PROVIDERS, providerById, type ModelProviderId } from "../modelProviders";

/**
 * One-click provider selection shared by the settings dialog and the first-run wizard.
 * Choosing a preset fills in the endpoint and the alias mapping; only the key is left to the user.
 */
export function ProviderPicker({
  provider,
  onSelect
}: {
  provider: ModelProviderId;
  onSelect: (provider: ModelProviderId) => void;
}) {
  const { t } = useLocale();
  const preset = providerById(provider);

  return (
    <div className="provider-picker">
      <span className="provider-picker-label">{t("runtimeProvider")}</span>
      <div className="provider-options" role="radiogroup" aria-label={t("runtimeProvider")}>
        {MODEL_PROVIDERS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={provider === option.id}
            className={`provider-option ${provider === option.id ? "is-selected" : ""}`}
            onClick={() => onSelect(option.id)}
          >
            {option.id === "custom" ? t("runtimeProviderCustom") : option.label}
          </button>
        ))}
      </div>
      <small>
        {provider === "custom"
          ? t("runtimeProviderCustomHint")
          : provider === "anthropic"
            ? t("runtimeProviderOfficialHint")
            : t("runtimeProviderPresetHint", { url: preset?.baseUrl ?? "" })}
        {preset?.docsUrl && provider !== "custom" && (
          <>
            {" "}
            <a href={preset.docsUrl} target="_blank" rel="noreferrer">
              {t("runtimeProviderDocs")}
            </a>
          </>
        )}
      </small>
    </div>
  );
}
