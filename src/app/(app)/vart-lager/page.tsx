import type { Metadata } from "next";
import Link from "next/link";

import { StateMessage } from "@/components/ui/state-message";
import { NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { currentViewer } from "../lager/_lib/session";
import { HomeStock } from "./_components/home-stock";
import { PageHead } from "./_components/page-head";
import { PlaceBar } from "./_components/place-bar";
import { TodoList, type TodoItem } from "./_components/todo-list";
import { loadVartLagerFor } from "./_lib/data";
import { headingOf } from "./_lib/heading";
import { stockTodos } from "./_lib/model";

export const metadata: Metadata = { title: "Vårt lager" };

/**
 * Vårt lager: hur många pack av varje titel vi har i våra egna lager (Hemma, Kontoret …).
 * Överst den stora siffran och listan med vad som ska göras (räkna om, packa, beställ),
 * sedan en rad per titel: skriv antalet så sparas det. "+ Inköp" (egna produkter: "+ Packat")
 * lägger till pack, "Flytta" flyttar mellan lagren. Awish drar packen vid påfyllning.
 * Ägare, admin och läsare; bara ägare och admin skriver.
 */
export default async function VartLagerPage() {
  const ctx = await requireRoute("vart-lager");
  const viewer = await currentViewer();
  const view = await loadVartLagerFor(viewer, new Date(ctx.now));
  const scope = `${viewer.organization.id}:${viewer.user.userId}`;
  const heading = headingOf(view);
  const todos: TodoItem[] = stockTodos(view.rows).map((t) => ({
    key: t.titleId,
    verb: t.verb,
    title: t.title,
    qty: t.qty,
    tone: t.tone,
    // Räkna om och Packa görs här (raden); Beställ på Inköp.
    href: t.verb === "Beställ" ? "/prognos" : `#rad-${t.titleId}`,
  }));
  const awish = view.rows.some((r) => r.latest?.automatic);

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <PageHead
        eyebrow="Vårt lager"
        title={heading.title}
        aside={view.hasWarehouse && view.rows.length > 0 ? undefined : heading.aside}
        live={awish ? "Awish" : undefined}
        actions={
          <Link
            href="/prognos"
            // Under md står Inköp redan som underflik bredvid.
            className="inline-flex h-11 items-center rounded-sm border border-line-strong px-4 text-base text-fg transition-colors duration-fast ease-instrument hover:bg-hover max-md:hidden"
          >
            Inköp{NBSP}→
          </Link>
        }
      />
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
          <TodoList items={todos} done={heading.aside} />
          <HomeStock model={view} scope={scope} />
        </>
      )}
    </div>
  );
}
