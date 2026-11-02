import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "./icon";

type Variant = "primary" | "secondary" | "ghost" | "signal";
type Size = "sm" | "md";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  iconLeft?: IconName;
  iconRight?: IconName;
  /** Kortkommando som visas i monospace till höger, t.ex. "⌘K" */
  kbd?: string;
  loading?: boolean;
  children?: ReactNode;
};

const base =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm border font-medium transition-[background-color,border-color,color] duration-[120ms] ease-instrument disabled:pointer-events-none disabled:opacity-40";

const variants: Record<Variant, string> = {
  primary:
    "border-inverse bg-inverse text-on-inverse hover:bg-inverse-hover hover:border-inverse-hover",
  secondary: "border-line-strong bg-surface text-fg hover:bg-hover hover:border-line-control",
  ghost: "border-transparent bg-transparent text-muted hover:bg-hover hover:text-fg",
  signal: "border-signal bg-signal text-on-signal hover:bg-signal-fg hover:border-signal-fg",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-sm",
  md: "h-9 px-3.5 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    iconLeft,
    iconRight,
    kbd,
    loading,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Spinner />
      ) : iconLeft ? (
        <Icon name={iconLeft} className="-ml-0.5 shrink-0" />
      ) : null}
      <span>{children}</span>
      {iconRight ? <Icon name={iconRight} className="-mr-0.5 shrink-0" /> : null}
      {kbd ? (
        <kbd className="label -mr-1 ml-1 rounded-xs border border-current/20 px-1 text-[10px] leading-[14px] tracking-normal opacity-70">
          {kbd}
        </kbd>
      ) : null}
    </button>
  );
});

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="-ml-0.5 animate-spin" aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
      />
      <path d="M0.5 0.5h13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  /** Obligatorisk tillgänglig etikett, visas även som tooltip. */
  label: string;
  variant?: Exclude<Variant, "signal">;
  size?: Size;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = "ghost", size = "md", className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(
        base,
        variants[variant],
        size === "sm" ? "size-7" : "size-9",
        "px-0",
        className,
      )}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
});
