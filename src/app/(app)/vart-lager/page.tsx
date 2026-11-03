import type { Metadata } from "next";
import Link from "next/link";

import type React from "react";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { currentViewer } from "../lager/_lib/session";
import { HomeStock } from "./_components/home-stock";
import { PlaceBar } from "./_components/place-bar";
import { loadVartLagerFor } from "./_lib/data";
import { headingOf } from "./_lib/heading";

export const metadata: Metadata = { title: "Vårt lager" };

/**
 * Vårt lager: hur många pack av varje titel vi har i våra egna lager (Hemma, Kontoret …),
 * totalt eller per lager. Skriv antalet, det sparas (en inventering i valt lager).
 * "+ Inköp" lägger till pack i ett lager, "Flytta" flyttar mellan lagren. När Awish visar
 * att en automat fyllts på dras packen automatiskt ur automatens "Fylls på från".
 * Ägare, admin och läsare; bara ägare och admin skriver.
 */
export default async function VartLagerPage() {
  const ctx = await requireRoute("vart-lager");
  const viewer = await currentViewer();
  const view = await loadVartLagerFor(viewer, new Date(ctx.now));
  const scope = `${viewer.organization.id}:${viewer.user.userId}`;
  const heading = headingOf(view);

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="rise" style={{ "--i": 0 } as React.CSSProperties}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Vårt lager"
          title={heading.title}
          aside={heading.aside}
          actions={
            <Link
              href="/prognos"
              className="meta inline-flex min-h-7 items-center rounded-xs text-muted hover:text-fg"
            >
              Beställ{NBSP}→
            </Link>
          }
        />
      </div>
      {!view.hasWarehouse ? (
        <>
          <StateMessage kind="empty" message="Inget eget lager än." />
          <PlaceBar places={[]} totals={{}} selected={null} canEdit={view.canAddPlace} />
        </>
      ) : view.rows.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Inga titlar än."
          action={{ label: "Öppna Datakällor", href: "/datakallor" }}
        />
      ) : (
        <>
          <HomeStock model={view} scope={scope} />
          <p className="meta text-subtle">
            Fylls en automat på drar Awish packen ur automatens lager
            {view.totals.negative > 0
              ? ` · ${formatInt(view.totals.negative)} under 0: räkna om`
              : ""}
            .
          </p>
        </>
      )}
    </div>
  );
}
