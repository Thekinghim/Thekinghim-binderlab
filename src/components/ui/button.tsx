import { forwardRef, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "./icon";

/**
 * primary   Huvudåtgärden i en vy. Högst en per yta.
 * secondary Standard.
 * ghost     Låg vikt, i verktygsrader och tabellrader.
 * danger    Åtgärd som stoppar, raderar eller nollställer. Ofylld: text
 *           och kant i signal, så att den aldrig konkurrerar med larm i data.
 * danger-confirm  Fylld signal. Bara i bekräftelsemodalens slutsteg,
 *           när användaren redan valt den kritiska åtgärden.
 * signal    Föråldrad, ritas som danger. Byt till "danger".
 */
type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-confirm" | "signal";
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
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm border font-medium transition-[background-color,border-color,color] duration-fast ease-instrument";

const variants: Record<Exclude<Variant, "signal">, string> = {
  primary:
    "border-inverse bg-inverse text-on-inverse hover:border-inverse-hover hover:bg-inverse-hover",
  secondary: "border-line-strong bg-surface text-fg hover:border-line-control hover:bg-hover",
  ghost: "border-transparent bg-transparent text-muted hover:bg-hover hover:text-fg",
  danger:
    "border-signal-line bg-transparent text-signal-fg hover:border-signal hover:bg-signal-soft",
  "danger-confirm":
    "border-signal bg-signal text-on-signal hover:border-signal-hover hover:bg-signal-hover",
};

/**
 * Inaktiv: ingen fyllning, streckad kant och dämpad men läsbar text
 * (--bl-fg-disabled, ≥4.5:1). Formen bär läget, inte bara färgen, och
 * varianten slutar spela roll: en inaktiv primärknapp drar inte blicken.
 * Ghost har ingen kant när den är aktiv och får ingen när den är inaktiv,
 * annars blir en inaktiv ikon det mest framträdande i en verktygsrad.
 */
const disabledCls =
  "cursor-not-allowed border-dashed border-line-strong bg-transparent text-disabled";
const disabledGhostCls = "cursor-not-allowed border-transparent bg-transparent text-disabled";

const sizes: Record<Size, string> = {
  // Under md når träffytan 44 px (::before) utan att knappen ritas större.
  sm: "h-7 px-2.5 text-sm max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-2.5 max-md:before:content-['']",
  md: "h-9 px-3.5 text-base max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-1.5 max-md:before:content-['']",
};

function variantClass(variant: Variant, inactive: boolean) {
  if (inactive) return variant === "ghost" ? disabledGhostCls : disabledCls;
  return variants[variant === "signal" ? "danger" : variant];
}

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
    onClick,
    ...rest
  },
  ref,
) {
  // Laddning behåller variantens utseende och fokus men tar inga klick:
  // aria-disabled i stället för native disabled, annars hamnar
  // tangentbordsfokus på body när en fokuserad knapp börjar ladda.
  const inactive = Boolean(disabled) && !loading;
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      e.preventDefault(); // stoppar även formulärsubmit
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      ref={ref}
      className={cn(
        base,
        variantClass(variant, inactive),
        sizes[size],
        loading && "cursor-progress",
        className,
      )}
      disabled={inactive}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
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
        <kbd className="label -mr-1 ml-1 rounded-xs border border-current/25 px-1 tracking-normal text-current/75">
          {kbd}
        </kbd>
      ) : null}
    </button>
  );
});

/**
 * Laddning: tre punkter som tänds i tur och ordning, läst som "pågår".
 * Ingen ram (liknade en tom kryssruta) och ingen rund spinner. Vid
 * reducerad rörelse står alla tre fasta (···), ett statiskt pågår-läge.
 */
function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      className="bl-ticks -ml-0.5 shrink-0"
      fill="currentColor"
      aria-hidden
    >
      <rect x="1" y="6" width="2" height="2" className="animate-tick" />
      <rect x="6" y="6" width="2" height="2" className="animate-tick" />
      <rect x="11" y="6" width="2" height="2" className="animate-tick" />
    </svg>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  /** Obligatorisk tillgänglig etikett, visas även som tooltip. */
  label: string;
  variant?: Exclude<Variant, "signal" | "danger-confirm">;
  size?: Size;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = "ghost", size = "md", className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(
        base,
        variantClass(variant, Boolean(disabled)),
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
