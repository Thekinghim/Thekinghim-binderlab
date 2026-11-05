import type { Metadata } from "next";
import { hideInDemo } from "@/server/demo/pages";
import { requireUser } from "@/server/session";

import { DataModelPage } from "./datamodel-page";

export const metadata: Metadata = { title: "Datamodell" };

/** Hela schemat med roller och RLS: bara för inloggade (även proxyn kräver det). */
export default async function Page() {
  await requireUser();
  // Internt: inte i en demo (Demo för kunder).
  await hideInDemo();
  return <DataModelPage />;
}
