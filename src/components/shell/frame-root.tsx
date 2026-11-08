"use client";

import type { ReactNode } from "react";

import { LocaleProvider, LocaleSync } from "@/i18n/client";
import type { Locale } from "@/i18n/locale";

import type { Role } from "./nav";
import { SimpleShell } from "./simple-shell";

/**
 * Språket och skalet: LocaleProvider för klientkomponenterna (personens språk), och Enkel vy
 * (memberships.view_mode) med det nerskalade skalet i stället för hela appens.
 */
export function AppFrameRoot({
  locale,
  simple,
  topBar = true,
  children,
}: {
  locale: Locale;
  /** Enkel vy: roll och e-post till det nerskalade skalet. null = hela appen. */
  simple: { role: Role; email: string } | null;
  /** Enkel vy: raden överst med ordmärket och menyn (Fyll på har en egen). */
  topBar?: boolean;
  children: ReactNode;
}) {
  return (
    <LocaleProvider locale={locale}>
      <LocaleSync locale={locale} />
      {simple ? (
        <SimpleShell
          role={simple.role as Exclude<Role, "store">}
          email={simple.email}
          topBar={topBar}
        >
          {children}
        </SimpleShell>
      ) : (
        children
      )}
    </LocaleProvider>
  );
}
