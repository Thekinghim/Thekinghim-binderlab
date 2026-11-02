"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import type { Role } from "@/components/shell/nav";
import type { SyncState } from "@/components/shell/sidebar";

const stores = [
  { id: "s1", name: "Helsingborg C" },
  { id: "s2", name: "Malmö Triangeln" },
  { id: "s3", name: "Lund Nova" },
];
const machines = [
  { id: "m1", code: "BL-001", name: "Entré", storeId: "s1" },
  { id: "m2", code: "BL-006", name: "Plan 2", storeId: "s1" },
  { id: "m3", code: "BL-009", name: "Foodcourt", storeId: "s2" },
  { id: "m4", code: "BL-010", name: "Kassalinjen", storeId: "s3" },
];

export function LabShell({
  role,
  syncState,
  children,
}: {
  role: Role;
  syncState: SyncState;
  children: ReactNode;
}) {
  return (
    <AppShell
      crumbs={["Binderlab Sverige AB", "Lönsamhet"]}
      activeHref="/lonsamhet"
      role={role}
      user={{ name: "Wilhelm Lindqvist", email: "wilhelm@binderlab.se" }}
      organizations={[
        { id: "o1", name: "Binderlab Sverige AB", detail: "14 automater" },
        { id: "o2", name: "Binderlab Norge AS", detail: "3 automater" },
      ]}
      activeOrganizationId="o1"
      todoCount={7}
      syncedAt="2026-11-01T20:23:00Z"
      syncState={syncState}
      stores={stores}
      machines={machines}
      earliest={new Date(2025, 2, 14)}
    >
      {children}
    </AppShell>
  );
}
