import type { ReactNode } from "react";
import { StateMessage, type StateKind } from "./state-message";

type EmptyStateProps = {
  /** Ersätter prefixet "0 RADER", t.ex. "0 AV 1 240". */
  code?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  kind?: StateKind;
  compact?: boolean;
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
      className={className}
    />
  );
}
