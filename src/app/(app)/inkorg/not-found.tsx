import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page } from "@/components/v2/shell/page";

/** Okänt ärende (notFound() i sidan): fel länk, borttagen, eller hör till en annan organisation. */
export default function NotFound() {
  return (
    <V2Page title="Ärendet finns inte">
      <Card>
        <Empty
          title="Inget ärende i inkorgen har det här id:t."
          action={
            <ButtonLink href="/inkorg" touch>
              Till Inkorg
            </ButtonLink>
          }
        >
          Länken kan vara fel, eller så hör ärendet till en annan organisation.
        </Empty>
      </Card>
    </V2Page>
  );
}
