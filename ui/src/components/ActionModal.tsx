import { ReactNode } from "react";

export function ActionModal({
  title,
  description,
  confirmLabel,
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
  children
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="modal-overlay active" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <div className="chat-confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="maestro-action-modal-title">
        <h3 id="maestro-action-modal-title">{title}</h3>
        {description ? <p>{description}</p> : null}
        {children}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button type="button" className="btn-new" onClick={onConfirm} disabled={busy}>{busy ? "…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
