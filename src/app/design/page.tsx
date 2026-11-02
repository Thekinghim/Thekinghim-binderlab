import type { Metadata } from "next";
import { DesignSystemPage } from "./design-system-page";

export const metadata: Metadata = { title: "Designsystem" };

export default function Page() {
  return <DesignSystemPage />;
}
