"use client";

import { useCallback, useState } from "react";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  // If set, the confirm button stays disabled until the user types this
  // exact text — for actions with a big blast radius (e.g. delete campaign).
  requireText?: string;
};

type PendingConfirm = ConfirmOptions & { resolve: (v: boolean) => void };

// Promise-based replacement for window.confirm(), styled to match the app
// instead of a native browser dialog. Usage:
//   const { confirm, ConfirmDialog } = useConfirm();
//   if (!(await confirm({ title: "Delete this?", danger: true }))) return;
//   ...render <ConfirmDialog /> once, anywhere in the tree...
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [typed, setTyped] = useState("");

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setTyped("");
      setPending({ ...opts, resolve });
    });
  }, []);

  function close(result: boolean) {
    pending?.resolve(result);
    setPending(null);
  }

  const blocked = !!pending?.requireText && typed !== pending.requireText;

  const ConfirmDialog = pending ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => close(false)}>
      <div className="absolute inset-0 bg-ink/30" />
      <div
        className="relative bg-paper border border-ink-200 rounded-lg shadow-lg w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[15px] font-semibold text-ink mb-1.5">{pending.title}</div>
        {pending.description && (
          <p className="text-[13px] text-ink-600 mb-4 leading-relaxed">{pending.description}</p>
        )}
        {pending.requireText && (
          <div className="mb-4">
            <label className="text-[12px] text-ink-500 block mb-1">
              Type <b className="text-ink">{pending.requireText}</b> to confirm
            </label>
            <input
              autoFocus
              className="field-boxed w-full"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !blocked) close(true);
                if (e.key === "Escape") close(false);
              }}
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-quiet text-[13px]" onClick={() => close(false)}>
            {pending.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            autoFocus={!pending.requireText}
            className={pending.danger ? "btn-danger text-[13px]" : "btn-accent text-[13px]"}
            disabled={blocked}
            onClick={() => close(true)}
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, ConfirmDialog };
}
