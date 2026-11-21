import type { Metadata } from "next";

import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { requireRoute } from "@/server/data/core";

export const metadata: Metadata = { title: "Pengar" };

/**
 * Pengar (/pengar): tom sida från grunden (F0) med rätt roller och periodval. Pengar-gruppen
 * (G4) fyller den (resultat, vattenfall, vinst per automat, att betala, prisråd). Tills dess
 * leder sidan till Lönsamhet, där alla siffror finns.
 */
export default async function MoneyPage() {
  const ctx = await requireRoute("pengar");
  return (
    <V2Page title="Pengar" date={headerDate(new Date(ctx.now), ctx.timeZone)} period>
      <Card title="Pengar">
        <Empty
          title="Sidan byggs just nu"
          action={
            <ButtonLink href="/lonsamhet" variant="act">
              Alla siffror i Lönsamhet
            </ButtonLink>
          }
        >
          Resultat, vinst per automat och det som ska betalas samlas här.
        </Empty>
      </Card>
    </V2Page>
  );
}
