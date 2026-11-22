import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page } from "@/components/v2/shell/page";

/** Okänt eller ogiltigt import-id (notFound() i sidan). */
export default function ImportNotFound() {
  return (
    <V2Page title="Importen finns inte">
      <Card>
        <Empty
          title="Importen finns inte."
          action={
            <ButtonLink href="/datakallor#importlogg" touch>
              Till importloggen
            </ButtonLink>
          }
        >
          Länken kan vara fel, eller så hör importen till en annan organisation.
        </Empty>
      </Card>
    </V2Page>
  );
}
