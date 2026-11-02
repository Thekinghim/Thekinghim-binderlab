import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { StateMessage, type StateKind } from "./state-message";

type EmptyStateProps = {
  /** Ersätter prefixet "0 RADER", t.ex. "0 AV 1 240". */
  code?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  kind?: StateKind;
  compact?: boolean;
  /**
   * Egen yta (kant + bg-surface) i blockläge, så att läget står som en
   * panel i ett rutnät. Sätt false när det ligger inuti en Panel.
   */
  framed?: boolean;
  className?: string;
};

/**
 * Tomt läge. Tunn kvarvarande wrapper kring StateMessage; ny kod
 * använder StateMessage direkt.
 */
export function EmptyState({
  code,
  title,
  description,
  action,
  kind = "empty",
  compact,
  framed = true,
  className,
}: EmptyStateProps) {
  return (
    <StateMessage
      kind={kind}
      code={code}
      message={title}
      detail={description}
      action={action}
      compact={compact}
      className={cn(framed && !compact && "rounded-md border border-line bg-surface", className)}
    />
  );
}
