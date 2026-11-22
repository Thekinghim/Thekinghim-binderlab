import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page } from "@/components/v2/shell/page";

/** Okänd butik (notFound() i sidan): fel länk, eller en butik i en annan organisation. */
export default function StoreNotFound() {
  return (
    <V2Page title="Butiken finns inte">
      <Card>
        <Empty
          title="Butiken finns inte."
          action={
            <ButtonLink href="/butiker" touch>
              Alla butiker
            </ButtonLink>
          }
        >
          Länken kan vara fel, eller så hör butiken till en annan organisation.
        </Empty>
      </Card>
    </V2Page>
  );
}
