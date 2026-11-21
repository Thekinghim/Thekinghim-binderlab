import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Tomt läge i V2: en rad som säger vad som saknas och vad man gör åt det. */
export function Empty({
  title,
  children,
  action,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("v2-empty", className)}>
      <b>{title}</b>
      {children}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}
