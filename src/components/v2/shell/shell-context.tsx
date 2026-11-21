"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { Role } from "@/components/shell/nav";
import type { SyncState } from "@/components/shell/side-nav";

/** Det sidhuvudet behöver från skalet (V2). */
export type V2ShellInfo = {
  readonly role: Role;
  /** Senaste synk från Awish (ISO), för "Uppdaterad 10:43". */
  readonly syncedAt?: string;
  readonly syncState?: SyncState;
  /** Öppnar kommandomenyn (Ctrl K). */
  readonly openCommand: () => void;
  /** Organisationens tidszon. */
  readonly timeZone: string;
};

const ShellContext = createContext<V2ShellInfo | null>(null);

export function V2ShellProvider({ value, children }: { value: V2ShellInfo; children: ReactNode }) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** Skalets uppgifter, eller null utanför V2-skalet (Fyll på, tester). */
export function useV2Shell(): V2ShellInfo | null {
  return useContext(ShellContext);
}
