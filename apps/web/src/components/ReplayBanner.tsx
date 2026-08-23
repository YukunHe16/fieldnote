import { motion } from "motion/react";
import { useLocale } from "../i18n";

export function ReplayBanner({
  mode,
  prompt,
  playbooks
}: {
  mode: "frozen" | "with-artifact";
  prompt: string;
  playbooks: Array<{ title: string; polarity?: string }>;
}) {
  const { t } = useLocale();
  return (
    <motion.div
      className={`replay-banner ${mode === "with-artifact" ? "is-after" : "is-before"}`}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.34 }}
    >
      <span className="replay-stave" aria-hidden="true" />
      <div>
        <p>{mode === "with-artifact" ? t("replayAfter") : t("replayBefore")}</p>
        <b>{prompt}</b>
        {playbooks.length > 0 && (
          <small>{t("thisRoundHandbook", { titles: playbooks.map((item) => item.title).join(" · ") })}</small>
        )}
      </div>
    </motion.div>
  );
}
