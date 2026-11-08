/**
 * Kontroll 2, "Awish = appen": för varje kopplad automat jämförs den senaste läsningen av
 * facken i Awish (stock_locations.awish_fill, antal pack per titel) med Binderlabs saldo i
 * automaten (stock_levels).
 *
 * Det som hänt i appen efter läsningen (försäljning, påfyllning, justering) räknas in:
 *
 *   väntat saldo = Awish antal vid läsningen + ändringar i appen efter läsningen
 *
 * så en försäljning eller påfyllning efter läsningen ger ingen skillnad. En inventering i
 * appen efter läsningen gör jämförelsen omöjlig (titeln hoppas över). Titlar utan fack i
 * Awish jämförs inte. En läsning äldre än STALE_READ_MINUTES jämförs inte heller: den ger
 * varningen "gammal läsning" i stället.
 *
 * Kontroll 3, "Påfyllningar nådde Awish": varje påfyllning i appen det senaste dygnet i en
 * automat där push till Awish är påslagen ska ha en lyckad push (automation_log
 * 'awish_push') för automaten efter påfyllningen, eller en läsning av facken efter den som
 * visar appens antal för titeln (en push som inte hade något att ändra loggas inte).
 * Påfyllningar som ångrats räknas inte, och inte heller de senaste PUSH_GRACE_MINUTES
 * (pushen kan pågå).
 *
 * Mystery packs (`mysteryBatchSize`): facket fylls bara på när det är tomt, med en hel omgång,
 * och pushen till Awish fyller bara tomma fack. En påfyllning i ett mystery-fack som inte var
 * tomt når därför inte Awish med flit: det ger en varning ("fylldes på innan det var tomt"),
 * inget larm, och appens högre saldo i kontroll 2 likaså. Ett mystery-fack med fler pack än
 * en omgång i Awish och en påfyllning som inte är en hel omgång ger också en varning.
 */

import { mysteryBatch, mysteryRefillProblem } from "@/domain";

import { countText, plural, resultOf, skipped } from "./common";
import type { CheckFinding, CheckResult } from "./types";

/** En läsning äldre än så jämförs inte (varning). Synken läser var femte minut. */
export const STALE_READ_MINUTES = 30;
/** Påfyllningar så här nya bedöms inte än (pushen till Awish kan pågå). */
export const PUSH_GRACE_MINUTES = 2;
/** Så långt bakåt påfyllningarna kontrolleras. */
export const REFILL_WINDOW_HOURS = 24;

const MINUTE = 60_000;

export interface AwishTitleRead {
  readonly titleId: string;
  readonly titleName: string;
  /** Antal pack i Awish vid läsningen. */
  readonly awishUnits: number;
  /** Binderlabs saldo nu (null = inget saldo på platsen, räknas som 0). */
  readonly appUnits: number | null;
  /** Summan av appens ändringar efter läsningen (försäljning −, påfyllning +). */
  readonly changedSince: number;
  /** Titeln har inventerats i appen efter läsningen (jämförs inte). */
  readonly countedSince: boolean;
  /** Mystery pack: pack per omgång, annars null/utelämnat. */
  readonly mysteryBatchSize?: number | null;
}

export interface AwishMachineRead {
  readonly machineId: string;
  /** "BL-001" (koden, annars namnet). */
  readonly label: string;
  /** Senaste läsningen (ISO), null = aldrig läst. */
  readonly readAt: string | null;
  readonly titles: readonly AwishTitleRead[];
}

function minutesSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(iso)) / MINUTE));
}

export function awishStockCheck(input: {
  readonly machines: readonly AwishMachineRead[];
  readonly now: Date;
  readonly staleMinutes?: number;
}): CheckResult {
  if (input.machines.length === 0) {
    return skipped("awish_appen", "Inga automater är kopplade till Awish.");
  }
  const stale = input.staleMinutes ?? STALE_READ_MINUTES;
  const nowMs = input.now.getTime();
  const findings: CheckFinding[] = [];
  let compared = 0;
  let different = 0;
  let old = 0;
  let mystery = 0;
  for (const m of input.machines) {
    if (m.readAt === null || !Number.isFinite(Date.parse(m.readAt))) {
      old += 1;
      findings.push({ level: "warn", text: `${m.label}: facken har inte lästs från Awish än.` });
      continue;
    }
    const age = minutesSince(m.readAt, nowMs);
    if (age > stale) {
      old += 1;
      findings.push({
        level: "warn",
        text: `${m.label}: gammal läsning, facken lästes för ${age} min sedan. Jämförs inte.`,
        link: "/datakallor",
      });
      continue;
    }
    for (const t of m.titles) {
      const batch = mysteryBatch(t.mysteryBatchSize);
      if (batch !== null && t.awishUnits > batch) {
        mystery += 1;
        findings.push({
          level: "warn",
          text: `${m.label} ${t.titleName}: ${t.awishUnits} pack i Awish, mer än en omgång (${batch}). Mystery-facket fylls bara på när det är tomt.`,
        });
      }
      if (t.countedSince) continue;
      compared += 1;
      const expected = t.awishUnits + t.changedSince;
      const app = t.appUnits ?? 0;
      if (app === expected) continue;
      if (batch !== null && app > expected) {
        // Pushen fyller bara tomma mystery-fack: en påfyllning före 0 hålls tillbaka.
        mystery += 1;
        findings.push({
          level: "warn",
          text: `${m.label} ${t.titleName}: appen ${app} pack, Awish ${expected}. Mystery-facket fylldes på innan det var tomt, så Awish fylls inte på förrän facket är tomt.`,
        });
        continue;
      }
      different += 1;
      const after =
        t.changedSince === 0
          ? ""
          : ` (${t.changedSince > 0 ? "+" : "−"}${Math.abs(t.changedSince)} i appen efter läsningen)`;
      findings.push({
        level: "fail",
        text: `${m.label} ${t.titleName}: Awish ${t.awishUnits} pack${after}, appen ${app} pack.`,
      });
    }
  }
  return resultOf("awish_appen", {
    findings,
    figures: [
      { label: "Titlar jämförda", value: compared, unit: "count" },
      { label: "Skillnader", value: different, unit: "count" },
      { label: "Gamla läsningar", value: old, unit: "count" },
    ],
    summary: {
      pass: `Awish och appen visar samma antal pack (${compared} titlar i ${input.machines.length} ${plural(input.machines.length, "automat", "automater")}).`,
      warn:
        old > 0
          ? `Samma antal där det gick att jämföra; ${countText(old, "automat", "automater")} med gammal läsning.`
          : `Samma antal där det gick att jämföra; ${countText(mystery, "mystery-fack", "mystery-fack")} att se över.`,
      fail: `${countText(different, "titel", "titlar")} har olika antal i Awish och appen.`,
    },
  });
}

export interface RefillRow {
  readonly eventId: string;
  readonly machineId: string;
  readonly machineLabel: string;
  readonly titleName: string;
  readonly quantity: number;
  /** När påfyllningen sparades (ISO). */
  readonly at: string;
  /** Automatens push till Awish är påslagen (inloggning sparad och brytaren på). */
  readonly pushEnabled: boolean;
  /** Påfyllningen ångrades i Fyll på. */
  readonly undone: boolean;
  /** Titeln har inget fack i automaten enligt Awish (pushen kan inte nå den). */
  readonly noSlot?: boolean;
  /**
   * Awish lästes efter påfyllningen och visade då samma antal som appen för titeln. Då har
   * påfyllningen nått Awish även utan loggad push (pushen loggas bara när ett fack ändrades).
   */
  readonly confirmedByRead?: boolean;
  /** Mystery pack: pack per omgång, annars null/utelämnat. */
  readonly mysteryBatchSize?: number | null;
  /** Appens saldo i automaten just före påfyllningen (null = okänt). */
  readonly before?: number | null;
}

export interface PushRow {
  readonly machineId: string;
  /** När pushen loggades (ISO). */
  readonly at: string;
}

/** Klockorna (appen och databasen) kan skilja några sekunder. */
const CLOCK_SKEW_MS = 5_000;

export function refillPushCheck(input: {
  readonly refills: readonly RefillRow[];
  readonly pushes: readonly PushRow[];
  readonly now: Date;
  readonly pushConfigured: boolean;
}): CheckResult {
  if (!input.pushConfigured) {
    return skipped("pafyllning_awish", "Push till Awish är inte påslagen.");
  }
  const nowMs = input.now.getTime();
  const due = input.refills.filter(
    (r) =>
      r.pushEnabled &&
      !r.undone &&
      nowMs - Date.parse(r.at) >= PUSH_GRACE_MINUTES * MINUTE &&
      nowMs - Date.parse(r.at) <= REFILL_WINDOW_HOURS * 60 * MINUTE,
  );
  const pushesByMachine = new Map<string, number[]>();
  for (const p of input.pushes) {
    const list = pushesByMachine.get(p.machineId) ?? [];
    list.push(Date.parse(p.at));
    pushesByMachine.set(p.machineId, list);
  }
  const findings: CheckFinding[] = [];
  let missing = 0;
  for (const r of due) {
    const at = Date.parse(r.at);
    const batch = mysteryBatch(r.mysteryBatchSize);
    const problem =
      batch === null || r.before === null || r.before === undefined
        ? null
        : mysteryRefillProblem(r.before, r.quantity, batch);
    if (batch !== null && problem === "not_empty") {
      // Med flit inte till Awish (pushen fyller bara tomma mystery-fack): varning, inget larm.
      findings.push({
        level: "warn",
        text: `${r.machineLabel} ${r.titleName}: fylldes på med ${r.quantity} pack fast facket hade ${r.before} kvar. Mystery-facket fylls bara på när det är tomt.`,
      });
      continue;
    }
    if (batch !== null && problem === "not_one_batch") {
      findings.push({
        level: "warn",
        text: `${r.machineLabel} ${r.titleName}: fylldes på med ${r.quantity} pack, en omgång är ${batch}.`,
      });
    }
    const reached =
      r.confirmedByRead === true ||
      (pushesByMachine.get(r.machineId) ?? []).some((t) => t >= at - CLOCK_SKEW_MS);
    if (reached) continue;
    if (r.noSlot) {
      findings.push({
        level: "warn",
        text: `${r.machineLabel} ${r.titleName}: titeln har inget fack i Awish, påfyllningen (${r.quantity} pack) kunde inte skickas.`,
      });
      continue;
    }
    missing += 1;
    findings.push({
      level: "fail",
      text: `${r.machineLabel} ${r.titleName}: påfyllningen på ${r.quantity} pack har inte nått Awish (ingen lyckad push efter den).`,
    });
  }
  return resultOf("pafyllning_awish", {
    findings,
    figures: [
      { label: "Påfyllningar kontrollerade", value: due.length, unit: "count" },
      { label: "Utan push", value: missing, unit: "count" },
    ],
    summary: {
      pass:
        due.length === 0
          ? "Inga påfyllningar med push till Awish det senaste dygnet."
          : due.length === 1
            ? "Påfyllningen det senaste dygnet skickades till Awish."
            : `Alla ${due.length} påfyllningar det senaste dygnet skickades till Awish.`,
      warn: "Alla påfyllningar som kunde skickas nådde Awish.",
      fail: `${countText(missing, "påfyllning", "påfyllningar")} har inte nått Awish.`,
    },
  });
}
