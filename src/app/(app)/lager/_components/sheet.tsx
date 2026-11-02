"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { IconButton } from "@/components/ui/button";
import { ModalPanel } from "@/components/ui/modal";

/**
 * Registreringsarket på Lager. Samma <dialog> och yta som `Modal` (fokusfälla, Esc,
 * inert bakgrund, ark från botten på mobilen), men med en stängknapp på 44 × 44 px:
 * arket används stående vid automaten, ofta med en hand. `Modal` har 28 px.
 */
export function Sheet({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

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
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 mt-auto w-full max-w-none border-0 bg-transparent p-0 text-fg sm:m-auto sm:max-w-[420px]"
    >
      {open ? (
        <ModalPanel
          title={title}
          eyebrow={eyebrow}
          footer={footer}
          titleId={titleId}
          className="max-h-[85dvh] animate-enter rounded-t-md sm:rounded-md [&>header]:pr-16"
        >
          {/* IconButton har "relative" och size-9 i basklasserna (cn slår inte ihop): därför "!". */}
          <IconButton
            icon="close"
            label="Stäng"
            onClick={onClose}
            className="absolute! top-2 right-2 size-11!"
          />
          {children}
        </ModalPanel>
      ) : null}
    </dialog>
  );
}
