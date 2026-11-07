/**
 * Kontroll 6, "Datahygien" (de senaste 30 dagarna, testköp räknas inte):
 *
 *   order utan titel                 fel (vinsten per titel blir fel)
 *   order utan belopp (0 kr)         varning
 *   titlar som sålt utan inköpspris  fel (vinsten saknar de orderna)
 *   negativt saldo i en automat      fel
 *   negativt saldo i vårt lager      varning (tillåtet, Vårt lager visar "Räkna om")
 */

import { countText, kr, resultOf } from "./common";
import type { CheckFinding, CheckResult } from "./types";

export interface HygieneInput {
  readonly ordersWithoutTitle: number;
  readonly ordersWithoutAmount: number;
  readonly unpricedTitles: readonly {
    readonly titleId: string;
    readonly name: string;
    readonly orders: number;
    readonly revenueOre: number;
  }[];
  readonly negativeStock: readonly {
    readonly place: string;
    readonly kind: "machine" | "warehouse";
    readonly titleName: string;
    readonly quantity: number;
  }[];
}

export function hygieneCheck(input: HygieneInput): CheckResult {
  const findings: CheckFinding[] = [];
  if (input.ordersWithoutTitle > 0) {
    findings.push({
      level: "fail",
      text: `${countText(input.ordersWithoutTitle, "order", "order")} saknar titel. Koppla varunamnet till en titel.`,
      link: "/datakallor",
    });
  }
  if (input.ordersWithoutAmount > 0) {
    findings.push({
      level: "warn",
      text: `${countText(input.ordersWithoutAmount, "order", "order")} har beloppet 0 kr.`,
      link: "/order",
    });
  }
  for (const t of input.unpricedTitles) {
    findings.push({
      level: "fail",
      text: `${t.name} har sålt ${countText(t.orders, "gång", "gånger")} (${kr(t.revenueOre)}) utan inköpspris.`,
      link: `/inkopspriser?titel=${encodeURIComponent(t.titleId)}`,
    });
  }
  for (const s of input.negativeStock) {
    findings.push({
      level: s.kind === "machine" ? "fail" : "warn",
      text: `${s.place} ${s.titleName}: saldot är ${s.quantity} pack.`,
      link: s.kind === "machine" ? "/lager" : "/vart-lager",
    });
  }
  const fails = findings.filter((f) => f.level === "fail").length;
  return resultOf("datahygien", {
    findings,
    figures: [
      { label: "Order utan titel", value: input.ordersWithoutTitle, unit: "count" },
      { label: "Order utan belopp", value: input.ordersWithoutAmount, unit: "count" },
      { label: "Titlar utan inköpspris", value: input.unpricedTitles.length, unit: "count" },
      { label: "Negativa saldon", value: input.negativeStock.length, unit: "count" },
    ],
    summary: {
      pass: "Alla order har titel och belopp, alla sålda titlar har inköpspris, inga negativa saldon.",
      warn: "Inga fel; något att titta på.",
      fail: `${countText(fails, "sak", "saker")} att rätta i datan.`,
    },
  });
}
