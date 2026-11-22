import type { TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/**
 * Flerradigt fält i V2 (.v2-field och .v2-textarea): etikett över, hjälptext under.
 */
export function TextArea({
  id,
  label,
  hint,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { id: string; label: string; hint?: string }) {
  return (
    <div className="v2-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        aria-describedby={hint ? `${id}-msg` : undefined}
        className={cn("v2-textarea", className)}
        {...rest}
      />
      {hint ? (
        <p id={`${id}-msg`} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
