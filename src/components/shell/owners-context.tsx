"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * En butiksägare som val i filtret: bara ägare med fler än en aktiv butik (en ägare med en
 * butik väljs som butiken). `storeIds` är ägarens aktiva butiker.
 */
export type ShellOwner = {
  id: string;
  name: string;
  storeIds: string[];
};

const OwnersContext = createContext<readonly ShellOwner[]>([]);

/** Butiksägarna i skalets filter (sätts av appens ram, tom för påfyllare). */
export function ShellOwnersProvider({
  owners,
  children,
}: {
  owners: readonly ShellOwner[];
  children: ReactNode;
}) {
  return <OwnersContext.Provider value={owners}>{children}</OwnersContext.Provider>;
}

export function useShellOwners(): readonly ShellOwner[] {
  return useContext(OwnersContext);
}
