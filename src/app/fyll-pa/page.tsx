import { headers } from "next/headers";

import { PATHNAME_HEADER } from "@/components/shell/simple-view";

import { fillReturnTo } from "@/lib/fill-return";

import { FillPage } from "./_components/fill-page";
import { machineIdFrom } from "./_lib/route";

/**
 * Fyll på: automaterna efter behov (/fyll-pa) och en automat direkt (/fyll-pa/<id>, t.ex.
 * från QR-koden på automaten). Båda adresserna visar den här rutten (src/lib/rewrites.ts),
 * och appen väljer automaten ur adressen: proxyn skickar sökvägen i en header. Startsidan i
 * den installerade appen (src/app/manifest.ts). Fungerar utan uppkoppling (public/sw.js).
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pathname = (await headers()).get(PATHNAME_HEADER);
  const sp = await searchParams;
  return (
    <FillPage
      machineId={machineIdFrom(pathname)}
      routeMode={sp.rutt === "1"}
      returnTo={fillReturnTo(sp.fran)}
    />
  );
}
