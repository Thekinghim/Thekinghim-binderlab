import { DiagramLab } from "./diagram-lab";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; gray?: string }>;
}) {
  const sp = await searchParams;
  const theme = sp.theme === "light" || sp.theme === "print" ? sp.theme : "dark";
  return <DiagramLab theme={theme} gray={sp.gray === "1"} />;
}
