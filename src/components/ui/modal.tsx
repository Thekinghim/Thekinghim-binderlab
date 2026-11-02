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
      <div className="relative flex max-h-[85dvh] animate-enter flex-col rounded-t-md border border-line-strong bg-raised sm:rounded-md">
        <header className="flex items-start justify-between gap-4 border-b border-line p-5">
          <div className="flex min-w-0 flex-col gap-2">
            {eyebrow ? <p className="label text-subtle">{eyebrow}</p> : null}
            <h2 id={titleId} className="text-lg font-medium">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="text-base text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton
            icon="close"
            label="Stäng"
            size="sm"
            onClick={onClose}
            className="-mt-1 -mr-1"
          />
        </header>
        {children ? <div className="overflow-y-auto p-5">{children}</div> : null}
        {footer ? (
          <footer className="flex flex-col-reverse gap-2 border-t border-line p-4 sm:flex-row sm:justify-end">
            {footer}
          </footer>
        ) : null}
      </div>
    </dialog>
  );
}
