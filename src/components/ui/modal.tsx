"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "./button";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Monospace-rad ovanför rubriken, t.ex. "MASKIN / BL-014" */
  eyebrow?: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md";
};

/**
 * Modal byggd på <dialog>: fokusfälla, Esc och inert bakgrund ingår.
 * På mobil glider den upp som ett ark från botten.
 */
export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  description,
  children,
  footer,
  size = "md",
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        "m-0 mt-auto w-full max-w-none border-0 bg-transparent p-0 text-fg sm:m-auto",
        size === "sm" ? "sm:max-w-[420px]" : "sm:max-w-[560px]",
      )}
    >
      <ModalPanel
        title={title}
        eyebrow={eyebrow}
        description={description}
        footer={footer}
        onClose={onClose}
        titleId={titleId}
        descId={descId}
        className="max-h-[85dvh] animate-enter rounded-t-md sm:rounded-md v2:rounded-t-v2-lg v2:sm:rounded-v2-lg"
      >
        {children}
      </ModalPanel>
    </dialog>
  );
}

/**
 * Dialogens yta: rubrik, innehåll och knapprad. Modal ritar den i en
 * <dialog>; som statiskt exempel ritas den utan stängknapp.
 */
export function ModalPanel({
  title,
  eyebrow,
  description,
  children,
  footer,
  onClose,
  titleId,
  descId,
  className,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  titleId?: string;
  descId?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-md border border-line-strong bg-raised",
        // V2: vit panel med radie 12, ljus kant och mjuk skugga (som .v2-sheet).
        "v2:rounded-v2-lg v2:border-v2-line v2:bg-v2-panel v2:shadow-[0_10px_30px_rgb(0_0_0/0.12)]",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-4 border-b border-line p-5">
        <div className="flex min-w-0 flex-col gap-2">
          {eyebrow ? <p className="label text-subtle">{eyebrow}</p> : null}
          <h2 id={titleId} className="text-lg font-medium v2:text-v2-lg v2:font-[650]">
            {title}
          </h2>
          {description ? (
            <p id={descId} className="text-base text-muted">
              {description}
            </p>
          ) : null}
        </div>
        {onClose ? (
          <IconButton
            icon="close"
            label="Stäng"
            size="sm"
            onClick={onClose}
            className="-mt-1 -mr-1 shrink-0"
          />
        ) : null}
      </header>
      {children ? (
        <div
          className={cn(
            "min-h-0 overflow-y-auto p-5",
            // Arket står mot skärmens nederkant på mobil: luft för hemlinjen på iPhone.
            !footer && "max-sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))]",
          )}
        >
          {children}
        </div>
      ) : null}
      {footer ? (
        <footer className="flex flex-col-reverse gap-2 border-t border-line p-4 max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">
          {footer}
        </footer>
      ) : null}
    </div>
  );
}
