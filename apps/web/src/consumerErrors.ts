import { ApiError } from "./api";
import { t } from "./i18n";

export function consumerSendError(error: unknown, online = true) {
  if (!online || error instanceof TypeError) return t("networkInterrupted");
  if (error instanceof ApiError && error.status === 429) return t("rateLimited");
  return t("tryAgain");
}
