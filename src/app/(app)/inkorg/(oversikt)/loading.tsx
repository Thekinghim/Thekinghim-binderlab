import { SettingsLoading } from "@/app/(app)/installningar/_components/page-loading";

/** Medan sidan hämtar och räknar: rubriken och korten som skeleton. */
export default function InkorgLoading() {
  return <SettingsLoading label="Laddar inkorgen" main={[2, 6]} side={[3]} />;
}
