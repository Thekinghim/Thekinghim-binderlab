import type { TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/**
 * Flerradigt fält med samma form som Input i @/components/ui/field: mono-etikett,
 * kontrollkant på bg, hjälptext under. (Designsystemet saknar ett textområde.)
 */
export function TextArea({
  id,
  label,
  hint,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { id: string; label: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="label text-muted">
        {label}
      </label>
      <textarea
        id={id}
        aria-describedby={hint ? `${id}-msg` : undefined}
        className={cn(
          "min-h-24 w-full min-w-0 resize-y rounded-sm border border-line-control bg-bg px-3 py-2 text-base text-fg transition-[border-color] duration-fast ease-instrument placeholder:text-subtle hover:border-muted",
          className,
        )}
        {...rest}
      />
      {hint ? (
        <p id={`${id}-msg`} className="text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
