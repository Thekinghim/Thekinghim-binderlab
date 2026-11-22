import { fillReturnTo } from "@/lib/fill-return";

import { FillPage } from "../_components/fill-page";

/**
 * Reserv för /fyll-pa/<något>. En automat (/fyll-pa/<uuid>, t.ex. från QR-koden) visas av
 * /fyll-pa (src/lib/rewrites.ts skriver om adressen dit, så att listan och automaten är en
 * och samma rutt). Hit kommer bara adresser som inte är ett id (de visar listan), och
 * automaten själv om omskrivningen av något skäl inte gäller. Samma app som /fyll-pa.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ machineId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { machineId } = await params;
  const sp = await searchParams;
  return (
    <FillPage machineId={machineId} routeMode={sp.rutt === "1"} returnTo={fillReturnTo(sp.fran)} />
  );
}
