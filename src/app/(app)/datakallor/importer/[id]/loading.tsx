import { SettingsLoading } from "@/app/(app)/installningar/_components/page-loading";

/** Medan importen och radloggen hämtas: rubriken och korten som skeleton. */
export default function ImportLoading() {
  return <SettingsLoading label="Laddar importen" main={[3, 6]} side={[4]} />;
}
