"use client";

import type { ReactNode } from "react";
import { toast, Toaster } from "sonner";

import { usePhone } from "./use-media";

/** Notisernas tid (6 s). Sonner pausar vid hover och när fliken är dold. */
export const TOAST_MS = 6_000;

/**
 * Notiserna i V2 (sonner), monterade EN gång i skalet (AppShell och Fyll på). Nere till höger
 * på dator, ovanför bottenraden på telefon; svep ner för att stänga.
 */
/**
 * Ovanför bottenraden, och följer den när ViewportPin flyttar den (iPhone, viewport-pin.ts).
 * Sonners eget mobileOffset gäller bara under 600 px; bottenraden syns upp till 900 px
 * (PHONE_QUERY), så samma luft ges som offset för hela telefonbredden (liggande telefon).
 */
export const PHONE_TOAST_OFFSET = {
  bottom: "calc(76px + env(safe-area-inset-bottom, 0px) - var(--v2-vp-shift, 0px))",
  left: 12,
  right: 12,
} as const;

export function V2Toaster() {
  const phone = usePhone();
  return (
    <Toaster
      position={phone ? "bottom-center" : "bottom-right"}
      offset={phone ? PHONE_TOAST_OFFSET : 22}
      mobileOffset={PHONE_TOAST_OFFSET}
      duration={TOAST_MS}
      visibleToasts={3}
      gap={8}
      swipeDirections={["bottom", "right"]}
      theme="light"
    />
  );
}

function Shell({
  title,
  detail,
  tone,
  action,
}: {
  title: ReactNode;
  detail?: ReactNode;
  tone: "success" | "critical" | "neutral";
  action?: ReactNode;
}) {
  return (
    <div className="v2-toast" role="status">
      {tone !== "neutral" ? (
        <span className={tone === "critical" ? "ok critical" : "ok"} aria-hidden="true">
          {tone === "critical" ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M12 7v6M12 17h.01" />
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m5 12 5 5 9-10" />
            </svg>
          )}
        </span>
      ) : null}
      <div className="tt">
        <b>{title}</b>
        {detail ? <small>{detail}</small> : null}
      </div>
      {action}
    </div>
  );
}

/** En notis: "Sparat", "Kunde inte spara" (tone critical). */
export function toastV2(
  title: ReactNode,
  options: { detail?: ReactNode; tone?: "success" | "critical" | "neutral"; id?: string } = {},
): string | number {
  return toast.custom(
    () => <Shell title={title} detail={options.detail} tone={options.tone ?? "success"} />,
    { id: options.id, duration: TOAST_MS },
  );
}

/**
 * Notis med Ångra (prototypens toast): "Påfyllt · Borås 2" med knappen Ångra i 6 s.
 * `onUndo` körs när man trycker; notisen stängs då.
 */
export function toastUndo(
  title: ReactNode,
  detail: ReactNode | undefined,
  onUndo: () => void,
  options: { id?: string; label?: string } = {},
): string | number {
  return toast.custom(
    (id) => (
      <Shell
        title={title}
        detail={detail}
        tone="success"
        action={
          <button
            type="button"
            className="v2-btn"
            onClick={() => {
              toast.dismiss(id);
              onUndo();
            }}
          >
            {options.label ?? "Ångra"}
          </button>
        }
      />
    ),
    { id: options.id, duration: TOAST_MS },
  );
}

export { toast as sonnerToast };
