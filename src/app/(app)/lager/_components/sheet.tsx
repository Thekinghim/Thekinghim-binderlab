"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { IconButton } from "@/components/ui/button";
import { ModalPanel } from "@/components/ui/modal";
import { useV2Shell } from "@/components/v2/shell/shell-context";
import { Sheet as V2Sheet } from "@/components/v2/sheet";

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Stängknappens etikett (standard "Stäng"). */
  closeLabel?: string;
};

/**
 * Registreringsarket på Lager. I appens V2-skal: V2:s ark (vaul), som övriga ark i appen
 * (dras ner, låser sidan bakom, fält i fokus rullas fram över tangentbordet). Utanför skalet
 * (Enkel vy, Fyll på): samma <dialog> och yta som `Modal`, men med en stängknapp på
 * 44 × 44 px: arket används stående vid automaten, ofta med en hand. `Modal` har 28 px.
 */
export function Sheet(props: SheetProps) {
  return useV2Shell() ? <VaulSheet {...props} /> : <DialogSheet {...props} />;
}

function VaulSheet({ open, onClose, title, eyebrow, children, footer, closeLabel }: SheetProps) {
  return (
    <V2Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      eyebrow={eyebrow}
      footer={footer}
      closeLabel={closeLabel}
      // Innehållet har egen luft (px-5 pb-5), som i <dialog>-arket.
      flush
    >
      {children}
    </V2Sheet>
  );
}

function DialogSheet({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  closeLabel = "Stäng",
}: SheetProps) {
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
            label={closeLabel}
            onClick={onClose}
            className="absolute! top-2 right-2 size-11!"
          />
          {children}
        </ModalPanel>
      ) : null}
    </dialog>
  );
}
