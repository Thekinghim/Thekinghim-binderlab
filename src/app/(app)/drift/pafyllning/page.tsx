import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { formatWhen } from "../_lib/display";
import { loadRefillData } from "../_lib/load";
import { RefillApp } from "./refill-app";

export const metadata: Metadata = { title: "Påfyllning" };

/**
 * Påfyllning i fältet: fungerar utan uppkoppling. Sidan sparas av service workern, och
 * påfyllningar köas i webbläsaren tills de kan skickas. Ägare, admin och påfyllare.
 */
export default async function RefillPage() {
  const ctx = await requireRoute("drift");
  if (ctx.role === "viewer") {
    return (
      <div className="flex flex-col gap-8">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Påfyllning"
          title="Påfyllning registreras av ägare, admin och påfyllare."
        />
        <StateMessage
          kind="denied"
          message="Läsare kan se lagret men inte registrera påfyllningar."
          action={{ label: "Öppna Lager", href: "/lager" }}
        />
      </div>
    );
  }
  const data = await loadRefillData(ctx);
  const now = new Date(ctx.now);
  const last = data.recent[0];
  const today = data.recent.filter((r) => r.occurredAt.slice(0, 10) === ctx.now.slice(0, 10));
  const packsToday = today.reduce((n, r) => n + r.quantity, 0);

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        className="rise"
        as="h1"
        size="xl"
        eyebrow="Påfyllning"
        title={
          today.length === 0
            ? "Ingen påfyllning registrerad i dag."
            : `${formatInt(packsToday)}${NBSP}pack påfyllda i dag.`
        }
        aside={
          last
            ? `Senast ${formatWhen(last.occurredAt, ctx.timeZone, now)}.`
            : "Fungerar utan uppkoppling."
        }
      />
      {data.machines.length === 0 ? (
        <StateMessage kind="empty" message="Inga automater att fylla på." />
      ) : (
        <RefillApp
          scope={`${ctx.organization.id}:${ctx.user.id}`}
          machines={data.machines}
          titles={data.titles}
          stock={data.stock}
          warehouse={data.warehouse}
          sources={data.sources}
        />
      )}
    </div>
  );
}
