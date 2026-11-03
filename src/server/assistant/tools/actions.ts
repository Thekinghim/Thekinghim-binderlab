/**
 * foresla_knapp: assistenten föreslår knappar som användaren själv klickar på, t.ex.
 * "Öppna påfyllning för Sega gubben" eller "Gå till Inköpspriser för Perfect Order".
 *
 * Knapparna är bara navigering till sidor som rollen får se. Ingen knapp skriver data:
 * ändringar görs på sidan, med sidans egna knappar och bekräftelser. Modellen anger typ
 * och namn; adressen byggs här av en vitlista, aldrig av modellens text.
 */

import "server-only";

import { z } from "zod";

import { routeById, type RouteId } from "@/components/shell/nav";

import type { ToolLink } from "../protocol";
import { defineTool, resolveOne, resolveTitle, type ToolContext } from "./common";

const PAGES = {
  hem: "hem",
  att_gora: "att-gora",
  lonsamhet: "lonsamhet",
  order: "order",
  lager: "lager",
  vart_lager: "vart-lager",
  automater: "automater",
  butiker: "butiker",
  inkopspriser: "inkopspriser",
  prognos: "prognos",
  drift: "drift",
  ekonomi: "ekonomi",
  avtal: "avtal",
  rapporter: "rapporter",
  datakallor: "datakallor",
} as const satisfies Record<string, RouteId>;

const buttonSchema = z
  .object({
    typ: z
      .enum(["sida", "pafyllning", "inkopslista", "inkopspris", "automat", "butik", "besoksplan"])
      .describe(
        "sida: öppna en sida (ange sida). pafyllning: packlistan för en automat eller butik (ange automat eller butik). inkopslista: inköpsförslaget på Prognos & inköp. inkopspris: Inköpspriser för en titel (ange titel). automat/butik: automatens eller butikens sida. besoksplan: veckans besök.",
      ),
    etikett: z
      .string()
      .min(2)
      .max(60)
      .describe("Knappens text, kort och på svenska: 'Öppna påfyllning för Sega gubben'."),
    sida: z.enum(Object.keys(PAGES) as [keyof typeof PAGES, ...(keyof typeof PAGES)[]]).optional(),
    automat: z.string().min(1).max(100).optional(),
    butik: z.string().min(1).max(100).optional(),
    titel: z.string().min(1).max(200).optional(),
  })
  .strict();

const actionsInput = z
  .object({
    knappar: z.array(buttonSchema).min(1).max(3).describe("1–3 knappar, viktigast först."),
  })
  .strict();

type Button = z.infer<typeof buttonSchema>;

async function hrefFor(ctx: ToolContext, b: Button): Promise<{ href: string; route: RouteId }> {
  const master = await ctx.master();
  const q = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;
  switch (b.typ) {
    case "sida": {
      const route = PAGES[b.sida ?? "hem"];
      return { href: routeById(route).href, route };
    }
    case "pafyllning": {
      if (b.automat) {
        const m = resolveOne(master.machines, b.automat, "automat");
        return { href: `/lager${q({ automat: m.id })}`, route: "lager" };
      }
      if (b.butik) {
        const s = resolveOne(master.stores, b.butik, "butik");
        return { href: `/lager${q({ butik: s.id })}`, route: "lager" };
      }
      return { href: "/lager", route: "lager" };
    }
    case "inkopslista":
      return { href: "/prognos#inkopsforslag", route: "prognos" };
    case "inkopspris": {
      if (!b.titel) return { href: "/inkopspriser", route: "inkopspriser" };
      const t = resolveTitle(master, b.titel);
      return { href: `/inkopspriser${q({ titel: t.id })}`, route: "inkopspriser" };
    }
    case "automat": {
      const m = resolveOne(master.machines, b.automat ?? "", "automat");
      return {
        href: `/automater/${encodeURIComponent(m.code.toLowerCase())}`,
        route: "automater",
      };
    }
    case "butik": {
      const s = resolveOne(master.stores, b.butik ?? "", "butik");
      return { href: `/butiker/${encodeURIComponent(s.id)}`, route: "butiker" };
    }
    case "besoksplan":
      return { href: "/drift/besok", route: "drift" };
  }
}

export const actionsTool = defineTool({
  name: "foresla_knapp",
  title: "Föreslå knappar",
  label: () => "Förslag på knappar",
  description:
    "Visar 1–3 knappar under svaret som tar användaren till rätt ställe för nästa steg, t.ex. 'Öppna påfyllning för Sega gubben', 'Skapa inköpslista' (inköpsförslaget), 'Gå till Inköpspriser för Perfect Order'. Knapparna öppnar bara sidor; ingenting ändras förrän användaren själv gör det på sidan. Använd när svaret slutar med ett konkret förslag. Anropa högst en gång per svar.",
  roles: ["owner", "admin", "viewer", "refiller"],
  input: actionsInput,
  async run(ctx: ToolContext, input) {
    const actions: ToolLink[] = [];
    const skipped: string[] = [];
    for (const b of input.knappar) {
      const { href, route } = await hrefFor(ctx, b);
      if (!routeById(route).roles.includes(ctx.role)) {
        skipped.push(b.etikett);
        continue;
      }
      if (!actions.some((a) => a.href === href)) actions.push({ label: b.etikett, href });
    }
    return {
      summary:
        actions.length > 0
          ? `Visar ${actions.length === 1 ? "en knapp" : `${actions.length} knappar`}: ${actions.map((a) => a.label).join(", ")}.`
          : "Inga knappar (rollen ser inte de sidorna).",
      data: { knappar: actions, utelamnade: skipped },
      figures: [],
      links: [],
      actions,
    };
  },
});
