/**
 * Tidslinje per automat: försäljning, lagerhändelser (påfyllning, inventering, svinn, flytt),
 * leverantörens maskinhändelser och ärenden i en sammanslagen lista.
 *
 * Regler:
 * - Bara händelser för automaten och med tidpunkt i [from, to) tas med.
 * - Försäljning grupperas enligt `salesGrouping`: en rad per order, per lokal timme (standard)
 *   eller per affärsdag. Lagerhändelser av typen `sale` hoppas över, eftersom orderna redan
 *   visar försäljningen (en order ger alltid en sådan händelse).
 * - Order utan `orderedAt` tas med på affärsdatumets lokala midnatt och grupperas per dag.
 * - Ett ärende ger två rader: öppnat och (om det är stängt) stängt.
 * - Sortering på tidpunkt (senaste först som standard), sedan typ och nyckel, så att ordningen
 *   alltid är densamma.
 */

import { plural } from "@/analytics/todos/text";
import { DEFAULT_TIME_ZONE, localParts, parseInstant } from "@/analytics/todos/time";
import { evidence, nameLookup } from "@/analytics/todos/common";
import { floorHour, localDayStartMs } from "./calendar";
import { hourRangeText } from "./text";
import type {
  MachineIncident,
  MachineSignal,
  MachineStockEvent,
  TimelineEntry,
  TimelineInput,
  TimelineKind,
  TimelineOptions,
} from "./types";

const KIND_ORDER: Record<TimelineKind, number> = {
  incident_opened: 0,
  signal: 1,
  refill: 2,
  count: 3,
  transfer: 4,
  adjustment: 5,
  waste: 6,
  sales: 7,
  incident_closed: 8,
};

const SIGNAL_TEXT: Record<MachineSignal["kind"], string> = {
  online: "Online igen",
  offline: "Offline",
  heartbeat: "Kontakt",
  fault: "Fel",
  fault_cleared: "Fel åtgärdat",
};

/**
 * Tidslinjen för en automat under [from, to).
 * Exempel på rader: "Försäljning 14–15: 3 pack", "Påfyllning: 12 × 30th Celebration",
 * "Fel: Spiral 4 fastnar (E21)", "Ärende öppnat: Myntmekanism".
 */
export function machineTimeline(input: TimelineInput, options: TimelineOptions): TimelineEntry[] {
  const tz = options.timeZone ?? DEFAULT_TIME_ZONE;
  const fromMs = parseInstant(options.from);
  const toMs = parseInstant(options.to);
  const grouping = options.salesGrouping ?? "hour";
  const titleName = nameLookup(input.titles ?? []);
  const inRange = (ms: number) => ms >= fromMs && ms < toMs;
  const out: TimelineEntry[] = [];

  const entry = (
    e: Omit<TimelineEntry, "at" | "date" | "time"> & { ms: number },
  ): TimelineEntry => {
    const p = localParts(e.ms, tz);
    const { ms, ...rest } = e;
    return { ...rest, at: new Date(ms).toISOString(), date: p.date, time: p.time };
  };

  // Försäljning.
  const groups = new Map<
    string,
    { ms: number; ids: string[]; titles: Map<string, number>; label: string; dates: Set<string> }
  >();
  for (const o of input.orders) {
    if (o.machineId !== input.machineId) continue;
    const timed = o.orderedAt !== undefined;
    const ms = timed ? parseInstant(o.orderedAt as string) : localDayStartMs(o.businessDate, tz);
    if (!inRange(ms)) continue;
    let key: string;
    let label: string;
    let groupMs: number;
    if (grouping === "order" && timed) {
      key = `sales:order:${o.id}`;
      label = "Försäljning";
      groupMs = ms;
    } else if (grouping === "hour" && timed) {
      const hourStart = floorHour(ms);
      const p = localParts(hourStart, tz);
      key = `sales:hour:${new Date(hourStart).toISOString().slice(0, 13)}`;
      label = `Försäljning ${hourRangeText(Number(p.time.slice(0, 2)))}`;
      groupMs = hourStart;
    } else {
      key = `sales:day:${o.businessDate}`;
      label = "Försäljning under dagen";
      groupMs = localDayStartMs(o.businessDate, tz);
    }
    let g = groups.get(key);
    if (!g) {
      g = { ms: groupMs, ids: [], titles: new Map(), label, dates: new Set() };
      groups.set(key, g);
    }
    g.ids.push(o.id);
    g.dates.add(o.businessDate);
    g.titles.set(o.titleId, (g.titles.get(o.titleId) ?? 0) + 1);
  }
  for (const [key, g] of groups) {
    const titles = [...g.titles.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const detail = titles.map(([id, n]) => `${n} × ${titleName(id)}`).join(", ");
    out.push(
      entry({
        key,
        kind: "sales",
        ms: g.ms,
        title: `${g.label}: ${plural(g.ids.length, "pack", "pack")}`,
        detail,
        packs: -g.ids.length,
        severity: "info",
        evidence: evidence({
          rule: "Varje order är ett sålt pack.",
          orderIds: g.ids,
          dates: g.dates,
          titleIds: g.titles.keys(),
          machineIds: [input.machineId],
          figures: [{ key: "packs", label: "Sålda pack", value: g.ids.length, unit: "packs" }],
        }),
      }),
    );
  }

  for (const e of input.stockEvents ?? []) {
    if (e.machineId !== input.machineId || e.kind === "sale") continue;
    const ms = parseInstant(e.occurredAt);
    if (!inRange(ms)) continue;
    out.push(stockEntry(e, ms, titleName(e.titleId), entry));
  }

  for (const s of input.signals ?? []) {
    if (s.machineId !== input.machineId || s.kind === "heartbeat") continue;
    const ms = parseInstant(s.at);
    if (!inRange(ms)) continue;
    const text = [s.message?.trim(), s.code ? `(${s.code})` : ""].filter(Boolean).join(" ");
    out.push(
      entry({
        key: `signal:${s.id}`,
        kind: "signal",
        ms,
        title: SIGNAL_TEXT[s.kind],
        detail: text ? `${text}. Källa: ${s.source}.` : `Källa: ${s.source}.`,
        packs: 0,
        severity: s.kind === "offline" || s.kind === "fault" ? "critical" : "info",
        evidence: evidence({
          rule: "Händelse från leverantörens maskindata.",
          machineIds: [input.machineId],
        }),
      }),
    );
  }

  for (const i of input.incidents ?? []) {
    if (i.machineId !== input.machineId) continue;
    out.push(...incidentEntries(i, inRange, entry, input.machineId));
  }

  const dir = options.order === "asc" ? 1 : -1;
  return out.sort(
    (a, b) =>
      dir * (parseInstant(a.at) - parseInstant(b.at)) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

type EntryFn = (e: Omit<TimelineEntry, "at" | "date" | "time"> & { ms: number }) => TimelineEntry;

function stockEntry(
  e: MachineStockEvent,
  ms: number,
  title: string,
  entry: EntryFn,
): TimelineEntry {
  const qty = e.quantity;
  const abs = Math.abs(qty);
  let kind: TimelineKind;
  let head: string;
  let packs = qty;
  switch (e.kind) {
    case "refill":
    case "receipt":
      kind = "refill";
      head = `Påfyllning: ${abs} × ${title}`;
      break;
    case "count":
      kind = "count";
      head = `Inventering: ${plural(qty, "pack", "pack")} ${title}`;
      packs = 0;
      break;
    case "waste":
      kind = "waste";
      head = `Svinn: ${abs} × ${title}`;
      break;
    case "transfer_in":
      kind = "transfer";
      head = `Flytt in: ${abs} × ${title}`;
      break;
    case "transfer_out":
      kind = "transfer";
      head = `Flytt ut: ${abs} × ${title}`;
      break;
    default:
      kind = "adjustment";
      head = `Justering: ${qty > 0 ? "+" : qty < 0 ? "−" : ""}${abs} × ${title}`;
  }
  return entry({
    key: `stock:${e.id}`,
    kind,
    ms,
    title: head,
    detail: e.note?.trim() ?? "",
    packs,
    severity: e.kind === "waste" ? "warning" : "info",
    evidence: evidence({
      rule: "Lagerhändelse i automatens lagerplats.",
      titleIds: [e.titleId],
      machineIds: [e.machineId],
      figures: [{ key: "quantity", label: "Antal", value: qty, unit: "packs" }],
    }),
  });
}

function incidentEntries(
  i: MachineIncident,
  inRange: (ms: number) => boolean,
  entry: EntryFn,
  machineId: string,
): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const startMs = parseInstant(i.startedAt);
  const ev = evidence({ rule: "Ärende registrerat för automaten.", machineIds: [machineId] });
  const description = i.description?.trim() || i.kind;
  if (inRange(startMs)) {
    out.push(
      entry({
        key: `incident:${i.id}:opened`,
        kind: "incident_opened",
        ms: startMs,
        title: `Ärende öppnat: ${description}`,
        detail: i.endedAt === null ? "Pågår." : "",
        packs: 0,
        severity: i.endedAt === null ? "critical" : "warning",
        evidence: ev,
      }),
    );
  }
  if (i.endedAt !== null) {
    const endMs = parseInstant(i.endedAt);
    if (inRange(endMs)) {
      const minutes = Math.floor((endMs - startMs) / 60_000);
      const hours = Math.floor(minutes / 60);
      const dur = hours >= 1 ? plural(hours, "timme", "timmar") : `${minutes} min`;
      out.push(
        entry({
          key: `incident:${i.id}:closed`,
          kind: "incident_closed",
          ms: endMs,
          title: `Ärende stängt: ${description}`,
          detail: [
            i.actionTaken?.trim() ? `Åtgärd: ${i.actionTaken.trim()}.` : "",
            `Varade ${dur}.`,
          ]
            .filter(Boolean)
            .join(" "),
          packs: 0,
          severity: "info",
          evidence: {
            ...ev,
            figures: [{ key: "durationHours", label: "Timmar", value: hours, unit: "hours" }],
          },
        }),
      );
    }
  }
  return out;
}
