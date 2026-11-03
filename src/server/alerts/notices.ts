/**
 * Notiser i mobilen (managerpaket 8): det enkla läget ovanpå larmprenumerationen.
 *
 * En person har en knapp "Notiser på/av" och fyra typer (förval: alla). Allt sparas i
 * samma rad i alert_subscriptions som larminställningarna under "Fler val", så att
 * larmjobbet inte behöver något nytt:
 *
 *   på  = prenumerationen är aktiv och har kanalen push
 *   av  = push tas bort ur kanalerna (e-post ligger kvar om den var vald); finns ingen
 *         annan kanal stängs prenumerationen av (kanalerna måste ha minst en)
 *   typ = en grupp larmtyper (Slut i automat = låg/slut, Automat tyst = misstänkt fel,
 *         fel och ur drift, osv.). Alla typer valda = alla larm (kinds null), som förut.
 *
 * Rent, utan databas.
 */

import type { AlertKind } from "@/analytics/alerts";

import {
  ALERT_KINDS,
  defaultSubscription,
  FIELD_KINDS,
  type SubscriptionRow,
} from "./subscriptions";

export type NoticeType = "empty" | "silent" | "stopped" | "discovered";

export interface NoticeTypeOption {
  readonly value: NoticeType;
  readonly label: string;
  readonly kinds: readonly AlertKind[];
  /** Bara ägare och admin (det är de som kan göra något åt det). */
  readonly operatorsOnly: boolean;
}

/** Typerna i den ordning de visas. Korta ord, inga facktermer. */
export const NOTICE_TYPES: readonly NoticeTypeOption[] = [
  { value: "empty", label: "Slut i automat", kinds: ["low_stock"], operatorsOnly: false },
  {
    value: "silent",
    label: "Automat tyst",
    kinds: ["machine_suspected_fault", "machine_offline", "machine_fault"],
    operatorsOnly: false,
  },
  {
    value: "stopped",
    label: "Försäljningen kommer inte in",
    kinds: ["import_failed"],
    operatorsOnly: true,
  },
  {
    value: "discovered",
    label: "Ny automat hittad",
    kinds: ["machine_discovered"],
    operatorsOnly: true,
  },
];

/** Typerna rollen kan välja. Påfyllaren: bara automater och lager. */
export function noticeTypesFor(role: string): NoticeTypeOption[] {
  const operator = role === "owner" || role === "admin";
  return NOTICE_TYPES.filter(
    (t) =>
      (operator || !t.operatorsOnly) &&
      (role !== "refiller" || t.kinds.every((k) => FIELD_KINDS.includes(k))),
  );
}

export interface NoticeState {
  /** Notiser på för personen (aktiv prenumeration med push). */
  readonly on: boolean;
  /** Valda typer. */
  readonly types: NoticeType[];
}

/** Läget ur den sparade raden (null = inget sparat: av, alla typer förvalda). */
export function noticeState(row: SubscriptionRow | null, role: string): NoticeState {
  const options = noticeTypesFor(role);
  if (!row) return { on: false, types: options.map((t) => t.value) };
  const kinds = row.kinds;
  return {
    on: row.active && row.channels.includes("push"),
    types: options
      .filter((t) => kinds === null || t.kinds.every((k) => kinds.includes(k)))
      .map((t) => t.value),
  };
}

export type NoticeChange =
  | { readonly on: boolean; readonly types?: undefined }
  | { readonly on?: undefined; readonly types: readonly string[] };

/**
 * Den nya raden efter en ändring av knappen eller typerna. Övriga inställningar (tysta timmar,
 * automater, e-post) ligger kvar. Ger ett fel när inga typer är valda.
 */
export function applyNoticeChange(
  row: SubscriptionRow | null,
  change: NoticeChange,
  ctx: { userId: string; role: string },
): { ok: true; row: SubscriptionRow } | { ok: false; error: string } {
  const base = row ?? defaultSubscription(ctx.userId, ctx.role);
  if (change.on !== undefined) {
    if (change.on) {
      return {
        ok: true,
        row: {
          ...base,
          active: true,
          channels: base.channels.includes("push") ? base.channels : ["push", ...base.channels],
        },
      };
    }
    const rest = base.channels.filter((c) => c !== "push");
    return {
      ok: true,
      row:
        rest.length > 0
          ? { ...base, channels: rest }
          : // Kanalerna måste ha minst en: push ligger kvar men prenumerationen stängs av.
            { ...base, channels: ["push"], active: false },
    };
  }
  const options = noticeTypesFor(ctx.role);
  const chosen = options.filter((t) => change.types.includes(t.value));
  if (chosen.length === 0) return { ok: false, error: "Välj minst en typ." };
  let kinds: string[] | null;
  if (ctx.role === "refiller") {
    kinds = chosen.flatMap((t) => [...t.kinds]);
  } else if (chosen.length === options.length) {
    kinds = null;
  } else {
    // Typer utanför de fyra (t.ex. avvikande dag, vald under "Fler val") ligger kvar.
    const grouped = new Set<string>(NOTICE_TYPES.flatMap((t) => [...t.kinds]));
    const extra = (base.kinds ?? ALERT_KINDS).filter((k) => !grouped.has(k));
    kinds = [...new Set([...chosen.flatMap((t) => [...t.kinds]), ...extra])];
  }
  return { ok: true, row: { ...base, kinds } };
}
