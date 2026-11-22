import { SettingsLoading } from "@/app/(app)/installningar/_components/page-loading";

/** Medan ärendet hämtas: rubriken och formuläret som skeleton. */
export default function IncidentLoading() {
  return <SettingsLoading label="Laddar ärendet" main={[6]} side={[3, 3]} />;
}
