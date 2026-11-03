import { FillPage } from "./_components/fill-page";

/**
 * Fyll på (/fyll-pa): automaterna efter behov. Startsidan i den installerade appen
 * (src/app/manifest.ts). Fungerar utan uppkoppling (public/sw.js).
 */
export default function Page() {
  return <FillPage />;
}
