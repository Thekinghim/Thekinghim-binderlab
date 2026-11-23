/**
 * Ett kort per automat (Lager i automaterna, mockupen visuellt/01): automatens bild med packen
 * på skärmen och listan med det som ska fyllas på. Ren logik: korten byggs av Lagers vy
 * (automater och påfyllningslistor) och automaternas bilder (./v2-data.ts, MachineScreen).
 * Inga belopp: Lager visas för alla roller, även butiken.
 */

import { FLEET_STATUS_RANK, type FleetStatus } from "@/analytics/fleet-status";
import type { GlyphSlot, GlyphStatus } from "@/components/v2/machine-glyph-model";
import { glyphStatusOf } from "@/components/v2/machine-glyph-model";
import { formatInt } from "@/lib/format";
import { DEFAULT_MACHINE_LOOK, type MachineLook } from "@/lib/machine-look";

import type { LagerMachine, PackList } from "../../lager/_lib/types";
import type { MachineScreen } from "./v2-data";
import { glyphSlotsOf } from "./v2-model";

/** En titel att ta med (påfyllningslistans rad). */
export interface CardLine {
  readonly titleId: string;
  readonly name: string;
  readonly onHand: number;
  /** Pack att ta med (påfyllningslistan), eller plats kvar i facket för "room" och "info". */
  readonly take: number;
  /** Mål efter påfyllning (kapaciteten när Awish är läst). */
  readonly target: number;
  /**
   * "take": påfyllningslistan säger hur många som ska med. "room": facket är tomt eller nästan
   * (Awish) men listan tar inget med (t.ex. slut i vårt lager), så raden säger platsen.
   * "info": inget behöver fyllas, raden visar ett av de lägsta facken.
   */
  readonly kind: "take" | "room" | "info";
}

/** Nästan tomt fack (samma gräns som skärmens låga stapel). */
const LOW_SLOT = 0.25;
/** Fack som visas på ett lugnt kort. */
const INFO_LINES = 2;

export interface MachineCard {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly storeName: string | null;
  readonly city: string | null;
  readonly look: MachineLook;
  /** Flottans läge, null när det inte kunde läsas. */
  readonly status: FleetStatus | null;
  readonly daysLeft: number | null;
  readonly glyph: GlyphStatus;
  readonly slots: readonly GlyphSlot[];
  readonly units: number | null;
  readonly capacity: number | null;
  readonly lines: readonly CardLine[];
  /** Pack att ta med totalt. */
  readonly take: number;
  /** Titlar som behövs men saknas i vårt lager. */
  readonly missing: number;
  /** Besök i dag enligt planen. */
  readonly dueToday: boolean;
}

/**
 * Korten i ordningen "behöver mest först": besök i dag, sedan flottans läge (offline, tom,
 * fyll på …), flest pack att ta med och sist koden.
 */
export function machineCardsOf(
  machines: readonly LagerMachine[],
  lists: readonly PackList[],
  screens: ReadonlyMap<string, MachineScreen>,
): MachineCard[] {
  const screenOf = (id: string): MachineScreen | undefined => screens.get(id);
  const cards = machines.map((m): MachineCard => {
    const list = lists.find((l) => l.machineId === m.id);
    const sc = screenOf(m.id);
    const listed: CardLine[] = (list?.lines ?? []).map((l) => ({
      titleId: l.titleId,
      name: l.titleName,
      onHand: Math.max(0, l.onHand),
      take: l.quantity,
      target: l.target,
      kind: "take" as const,
    }));
    const seen = new Set(listed.map((l) => l.titleId));
    // Awish-facken som inte står i listan, lägst fyllnad först.
    const others: CardLine[] = (sc?.slots ?? [])
      .filter((s) => !seen.has(s.titleId) && s.capacity)
      .map((s) => ({
        titleId: s.titleId,
        name: s.name,
        onHand: Math.max(0, s.units),
        take: Math.max(0, (s.capacity ?? 0) - s.units),
        target: s.capacity ?? 0,
        kind: (s.units <= 0 || s.empty > 0 || s.units / (s.capacity ?? 1) <= LOW_SLOT
          ? "room"
          : "info") as CardLine["kind"],
      }))
      .sort(
        (a, b) => a.onHand / a.target - b.onHand / b.target || a.name.localeCompare(b.name, "sv"),
      );
    const byNeed = (a: CardLine, b: CardLine) =>
      a.onHand - b.onHand || b.take - a.take || a.name.localeCompare(b.name, "sv");
    const needed = [...listed, ...others.filter((l) => l.kind === "room")].sort(byNeed);
    const lines = needed.length > 0 ? needed : others.slice(0, INFO_LINES);
    const take = list?.totalPacks ?? 0;
    const dueToday = list?.dueToday === true && take > 0;
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      storeName: m.storeName ?? sc?.storeName ?? null,
      city: sc?.city ?? null,
      look: sc?.appearance ?? DEFAULT_MACHINE_LOOK,
      status: sc?.status ?? null,
      daysLeft: sc?.daysLeft ?? null,
      glyph: sc ? glyphStatusOf(sc.status) : dueToday ? "refill" : "ok",
      slots: sc ? glyphSlotsOf(sc.slots) : [],
      units: sc?.units ?? null,
      capacity: sc?.capacity ?? null,
      lines,
      take,
      missing: list?.missing.length ?? 0,
      dueToday,
    };
  });
  const need = (c: MachineCard) => c.lines.filter((l) => l.kind !== "info").length;
  const rank = (c: MachineCard) => (c.status === null ? 9 : FLEET_STATUS_RANK[c.status]);
  return cards.sort(
    (a, b) =>
      Number(b.dueToday) - Number(a.dueToday) ||
      rank(a) - rank(b) ||
      need(b) - need(a) ||
      b.take - a.take ||
      a.code.localeCompare(b.code, "sv", { numeric: true }),
  );
}

/** "2 titlar att fylla", "100 av 150 pack", "Ingen kontakt" – kortets korta rad. */
export function cardSummary(c: MachineCard): string {
  if (c.status === "offline") return "Offline";
  const needed = c.lines.filter((l) => l.kind !== "info").length;
  if (needed > 0) return `${formatInt(needed)} ${needed === 1 ? "titel" : "titlar"} att fylla`;
  if (c.units !== null && c.capacity !== null)
    return `${formatInt(c.units)} av ${formatInt(c.capacity)} pack`;
  if (c.units !== null) return `${formatInt(c.units)} pack`;
  return "Inget att fylla på";
}
