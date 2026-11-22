import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type NoticeTone = "info" | "success" | "warning" | "critical";

/**
 * Meddelanderuta (Polaris banner): mjuk ton, en prick, rubrik, text och en åtgärd till höger
 * (under på telefon). För "Kortavgiften står på 0 %"-rutor och liknande på de gamla sidorna,
 * i stället för röda ramar.
 *
 *   <Notice tone="warning" title="Kortavgiften står på 0 %." action={<ButtonLink href="…">Ändra</ButtonLink>}>
 *     Med 1,5 % är vinsten i år ca 910 kr lägre.
 *   </Notice>
 *
 * role="status" (critical: role="alert") bara när rutan dyker upp efter en åtgärd: sätt `live`.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  live = false,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  live?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("v2-notice", tone, className)}
      role={live ? (tone === "critical" ? "alert" : "status") : undefined}
    >
      <span className="dot" aria-hidden="true" />
      <div className="tx">
        {title ? <b>{title}</b> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="ac">{action}</div> : null}
    </div>
  );
}
