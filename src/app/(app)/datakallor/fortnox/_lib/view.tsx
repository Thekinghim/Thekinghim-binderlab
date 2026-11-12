/**
 * Fortnox-vyn (src/server/fortnox/service.ts) som listor att visa: det som skickas härnäst,
 * det som väntar på något, och utkorgen med Fortnox nummer.
 */

import type { ReactNode } from "react";

import type { FortnoxView } from "@/server/fortnox/service";
import type { OutboxRow } from "@/server/fortnox/sync";

import type { VoucherView } from "../_components/voucher-list";

/** Det som skickas vid nästa körning (i torrkörning: det som SKULLE skickas). */
export function nextVouchers(view: FortnoxView): VoucherView[] {
  const live = view.connection?.live === true;
  return view.next.map((v) => ({
    key: `next:${v.kind}:${v.sourceRef}`,
    date: v.date,
    description: v.description,
    rows: [...v.rows],
    tag: live ? "I natt" : "Skulle skickas",
    tagTone: "info",
  }));
}

/** Verifikat som inte kan tas fram än, med orsaken i klartext. */
export function heldVouchers(view: FortnoxView): VoucherView[] {
  return view.held.map((v) => ({
    key: `held:${v.kind}:${v.sourceRef}`,
    date: v.date,
    description: v.description,
    rows: [],
    tag: "Väntar",
    tagTone: "warn",
    note: v.hold?.detail ?? null,
  }));
}

function tagOf(row: OutboxRow): Pick<VoucherView, "tag" | "tagTone" | "note"> {
  if (row.state === "sent") {
    return { tag: `${row.series} ${row.number}`, tagTone: "ok", note: null };
  }
  if (row.state === "blocked") {
    return row.blockCode === "withdrawn"
      ? { tag: "Skickas inte", tagTone: "info", note: row.blockDetail }
      : { tag: "Stoppat", tagTone: "warn", note: row.blockDetail };
  }
  if (row.state === "sending") {
    return {
      tag: "Kontrolleras",
      tagTone: "info",
      note: "Svaret från Fortnox kom inte fram. Nästa körning kontrollerar om verifikatet finns i Fortnox innan något skickas igen.",
    };
  }
  return { tag: "I natt", tagTone: "info", note: null };
}

/**
 * Utkorgen, nyast först. `reverse` ger knappen "Rätta" för ett skickat verifikat vars
 * underlag har ändrats eller försvunnit.
 */
export function outboxVouchers(
  view: FortnoxView,
  reverse?: (id: string) => ReactNode,
): VoucherView[] {
  const changed = new Map(view.changed.map((c) => [c.row.id, c.reason]));
  return view.outbox.map((row) => {
    const base = tagOf(row);
    const reason = changed.get(row.id);
    return {
      key: row.idemKey,
      date: row.date,
      description: row.description,
      rows: [...row.rows],
      ...base,
      ...(reason
        ? {
            tagTone: "warn" as const,
            note:
              reason === "gone"
                ? "Underlaget finns inte kvar här (t.ex. en arkiverad utbetalning), men verifikatet ligger kvar i Fortnox. Välj Rätta för att vända det."
                : "Siffrorna har ändrats här efter att verifikatet bokfördes. Välj Rätta för att vända det gamla och bokföra det nya.",
            action: reverse?.(row.id),
          }
        : {}),
    };
  });
}
