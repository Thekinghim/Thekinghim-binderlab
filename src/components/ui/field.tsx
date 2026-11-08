import {
  forwardRef,
  type CSSProperties,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "./icon";

type FieldShellProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
};

/** Etikett i monospace, hjälptext och fel. Fel markeras med ikon + text, inte bara färg. */
function FieldShell({ id, label, hint, error, children, className }: FieldShellProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="label text-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="flex items-center gap-1.5 text-xs text-signal-fg">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Fokus ritas av den globala :focus-visible-ringen (förgrundsfärg, 2px
 * utanför kanten), så en signalkant i felläge syns kvar innanför ringen.
 * Inaktiv: streckad kant, ingen fyllning, läsbar text (--bl-fg-disabled).
 */
const control =
  "h-9 max-md:h-11 w-full min-w-0 rounded-sm border bg-bg px-3 text-base text-fg transition-[border-color,background-color] duration-fast ease-instrument placeholder:text-subtle enabled:hover:border-muted disabled:cursor-not-allowed disabled:border-dashed disabled:border-line-strong disabled:bg-transparent disabled:text-disabled disabled:placeholder:text-disabled";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
  icon?: IconName;
  /** Enhet till höger i samma typsnitt som talet, t.ex. "kr", "st" eller "%" */
  suffix?: string;
  wrapperClassName?: string;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, icon, suffix, className, wrapperClassName, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <div className="relative">
        {icon ? (
          <Icon
            name={icon}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
          />
        ) : null}
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-msg` : undefined}
          className={cn(
            control,
            error ? "border-signal" : "border-line-control",
            icon && "pl-9",
            // Enhetens bredd plus 4px luft: värdet slutar tätt intill enheten.
            suffix && "pr-[calc(var(--spacing)*3+var(--sfx-w)+4px)]",
            // Tal sätts i Geist med tabulära siffror, aldrig i mono.
            rest.type === "number" && "tnum text-right",
            className,
          )}
          {...rest}
          style={
            suffix
              ? ({ ...rest.style, "--sfx-w": `${suffix.length}ch` } as CSSProperties)
              : rest.style
          }
        />
        {suffix ? (
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-base text-subtle">
            {suffix}
          </span>
        ) : null}
      </div>
    </FieldShell>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  error?: string;
  options: Array<{ value: string; label: string }>;
  wrapperClassName?: string;
};

/** Native select under huven: rätt beteende på mobil och med skärmläsare. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, className, wrapperClassName, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <div className="relative">
        <select
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-msg` : undefined}
          className={cn(
            control,
            "appearance-none pr-9",
            error ? "border-signal" : "border-line-control",
            className,
          )}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon
          name="chevronDown"
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-subtle"
        />
      </div>
    </FieldShell>
  );
});

type Validatable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function fieldLabel(el: Validatable): string {
  const text = el.labels?.[0]?.textContent?.trim();
  return text || el.getAttribute("aria-label") || el.name || "Fältet";
}

/** Webbläsarens valideringsfel som en svensk mening. */
export function swedishValidity(el: Validatable): string {
  const v = el.validity;
  const label = fieldLabel(el);
  if (v.valueMissing) return `${label}: fyll i fältet.`;
  if (v.typeMismatch && el.type === "email") return `${label}: ange en giltig e-postadress.`;
  if (v.typeMismatch) return `${label}: ogiltigt format.`;
  if (v.badInput) return `${label}: ange ett giltigt värde.`;
  if (v.rangeUnderflow) return `${label}: minst ${(el as HTMLInputElement).min}.`;
  if (v.rangeOverflow) return `${label}: högst ${(el as HTMLInputElement).max}.`;
  if (v.tooLong) return `${label}: högst ${(el as HTMLInputElement).maxLength} tecken.`;
  if (v.tooShort) return `${label}: minst ${(el as HTMLInputElement).minLength} tecken.`;
  if (v.stepMismatch) return `${label}: ogiltigt steg.`;
  if (v.patternMismatch) return `${label}: ogiltigt format.`;
  return `${label}: kontrollera värdet.`;
}

/**
 * För formulär med noValidate: hittar första ogiltiga fältet, flyttar
 * fokus dit och returnerar ett svenskt fel. null när allt stämmer.
 */
export function formError(form: HTMLFormElement): string | null {
  for (const el of Array.from(form.elements)) {
    if (
      (el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement) &&
      el.willValidate &&
      !el.checkValidity()
    ) {
      el.focus();
      return swedishValidity(el);
    }
  }
  return null;
}
