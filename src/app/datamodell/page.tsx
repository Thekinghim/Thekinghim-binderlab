import type { Metadata } from "next";
import { requireUser } from "@/server/session";

import { DataModelPage } from "./datamodel-page";

export const metadata: Metadata = { title: "Datamodell" };

/** Hela schemat med roller och RLS: bara för inloggade (även proxyn kräver det). */
export default async function Page() {
  await requireUser();
  return <DataModelPage />;
}
