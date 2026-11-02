import type { Metadata } from "next";
import { DataModelPage } from "./datamodel-page";

export const metadata: Metadata = { title: "Datamodell" };

export default function Page() {
  return <DataModelPage />;
}
