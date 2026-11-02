import {
  forwardRef,
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

const control =
  "h-9 w-full min-w-0 rounded-sm border bg-bg px-3 text-base text-fg transition-[border-color,background-color] duration-[120ms] ease-instrument placeholder:text-subtle hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-0 disabled:opacity-40";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
  icon?: IconName;
  /** Enhet till höger i monospace, t.ex. "kr" eller "st" */
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
            suffix && "pr-10",
            rest.type === "number" && "tnum text-right font-mono",
            className,
          )}
          {...rest}
        />
        {suffix ? (
          <span className="label pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-subtle">
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
