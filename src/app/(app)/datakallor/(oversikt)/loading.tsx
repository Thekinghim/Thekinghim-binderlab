import { SettingsLoading } from "@/app/(app)/installningar/_components/page-loading";

/** Medan sidan hämtar och räknar: rubriken och korten som skeleton. */
export default function DatakallorLoading() {
  return <SettingsLoading label="Laddar datakällor" main={[4, 2]} side={[3, 3]} />;
}
