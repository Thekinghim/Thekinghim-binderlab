import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";

import { PortalPage } from "../../_components/page-head";

/** Okänd rapport (notFound() i sidan): fel länk, borttagen, eller gäller en annan butik. */
export default function NotFound() {
  return (
    <PortalPage
      title="Rapporten finns inte"
      sub="Länken kan vara fel, eller så gäller rapporten en annan butik."
    >
      <Card>
        <Empty
          title="Ingen rapport för butiken har det här id:t."
          action={<ButtonLink href="/portal/rapporter">Alla rapporter</ButtonLink>}
        />
      </Card>
    </PortalPage>
  );
}
