import { FillPage } from "../_components/fill-page";

/**
 * En automat direkt (/fyll-pa/<id>, t.ex. från QR-koden på automaten). Samma app som
 * /fyll-pa; den väljer automaten ur adressen. Okänt id visar listan.
 */
export default async function Page({ params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  return <FillPage machineId={machineId} />;
}
