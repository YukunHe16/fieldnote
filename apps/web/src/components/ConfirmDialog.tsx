import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { useLocale } from "../i18n";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  workingLabel,
  working,
  onCancel,
  onConfirm
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  workingLabel?: string;
  working?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !working) onCancel();
          }}
        >
          <motion.div
            className="confirm-dialog material-light"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-description"
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", bounce: 0, duration: 0.32 }}
          >
            <span className="danger-glyph">
              <Icon name="trash" />
            </span>
            <h2 id="confirm-title">{title}</h2>
            <p id="confirm-description">{description}</p>
            <div>
              <button className="button-quiet" onClick={onCancel} disabled={working}>
                {t("cancel")}
              </button>
              <button className="button-danger" onClick={onConfirm} disabled={working}>
                {working ? (workingLabel ?? t("deleting")) : (confirmLabel ?? t("confirmDelete"))}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
