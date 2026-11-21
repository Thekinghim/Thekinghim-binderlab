"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Tre storlekar: sm 28 px, md 32 px, lg 44 px (prototypens v12). */
export type ButtonSize = "sm" | "md" | "lg";
/**
 * default: vit med kant. act: mörk primärknapp (åtgärden). plain: grå utan kant.
 * quiet: bara text (sekundär åtgärd, "Löst").
 */
export type ButtonVariant = "default" | "act" | "plain" | "quiet";

type Common = {
  size?: ButtonSize;
  variant?: ButtonVariant;
  /** Väntläge ("skickar"): snurra och inaktiv, texten står kvar. */
  pending?: boolean;
  /** 44 px hög på telefon oavsett storlek (tryckyta). */
  touch?: boolean;
  /** Bara en ikon: kvadratisk, kräver aria-label. */
  icon?: boolean;
  children: ReactNode;
};

function classes(p: Common, className?: string): string {
  return cn(
    "v2-btn",
    p.size === "sm" && "sm",
    p.size === "lg" && "lg",
    p.variant && p.variant !== "default" && p.variant,
    p.touch && "touch",
    p.icon && "ico",
    className,
  );
}

/** Knapp. `pending` ger en snurra och spärrar knappen. */
export function Button({
  size,
  variant,
  pending = false,
  touch,
  icon,
  children,
  className,
  disabled,
  type = "button",
  ...rest
}: Common & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type={type}
      className={classes({ size, variant, touch, icon, children }, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? <span className="spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** Länk som ser ut som en knapp (Fyll på → /fyll-pa/<id>). */
export function ButtonLink({
  size,
  variant,
  touch,
  icon,
  children,
  className,
  ...rest
}: Omit<Common, "pending"> & Omit<ComponentProps<typeof Link>, "children">) {
  return (
    <Link className={classes({ size, variant, touch, icon, children }, className)} {...rest}>
      {children}
    </Link>
  );
}
