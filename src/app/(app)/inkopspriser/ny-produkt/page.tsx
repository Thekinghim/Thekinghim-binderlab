import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { StateMessage } from "@/components/ui/state-message";
import { newProductPageFor } from "@/server/awish/new-product";
import { OPERATOR_ROLES, requireRoute, requireViewer } from "@/server/data/core";

import { PageHead } from "../../vart-lager/_components/page-head";
import { NewProductPanels } from "./_components/new-product-panels";

export const metadata: Metadata = { title: "Ny produkt" };

/**
 * Inköpspriser → Ny produkt: skapa en vara i Awish (och titeln med inköpspris i Binderlab)
 * och lägga en vara i ett fack. Bara ägare och admin; alla andra skickas tillbaka till
 * Inköpspriser. Kräver att push till Awish är påslaget under Datakällor.
 */
export default async function NewProductPage() {
  const ctx = await requireRoute("inkopspriser");
  if (!(OPERATOR_ROLES as readonly string[]).includes(ctx.role)) redirect("/inkopspriser");
  const data = await newProductPageFor(await requireViewer());

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-3">
        <PageHead
          eyebrow="Inköpspriser · Ny produkt"
          title="Ny produkt i Awish"
          aside="Skapa varan, lägg den i ett fack. Du ser allt innan det skickas."
        />
        <Link
          href="/inkopspriser"
          className="meta w-fit rounded-xs text-muted underline underline-offset-4 hover:text-fg"
        >
          ← Inköpspriser
        </Link>
      </div>
      {data.status.blocker ? (
        <StateMessage
          kind="empty"
          message={data.status.blocker}
          action={{ label: "Till Datakällor →", href: "/datakallor" }}
        />
      ) : (
        <NewProductPanels machines={data.machines} />
      )}
    </div>
  );
}
