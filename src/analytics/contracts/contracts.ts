/**
 * Avtal: nuvarande avtalsperiod, sista uppsägningsdag, påminnelser och översikt över hur
 * mycket av intäkten som ligger på avtal som snart löper ut.
 *
 * Regler:
 * - Sista uppsägningsdag = avtalets slut minus uppsägningstiden (hela månader, sedan dagar).
 *   Slutar avtalet på en månads sista dag blir sista uppsägningsdag också en månads sista dag:
 *   slut 30 juni 2027 med 3 månader → 31 mars 2027. Annars samma dag i månaden, kapad till
 *   månadens längd: slut 15 juni → 15 mars.
 * - Påminnelsen visas 90 dagar (inställbart) före sista uppsägningsdag, så att det finns tid
 *   att säga upp eller omförhandla. Med uppsägningstid 0 är det 90 dagar före slutet.
 * - Ett avtal som förlängs automatiskt (`renewalMonths`) och inte sagts upp förlängs med
 *   perioden när slutet passerat: ny slutdag = (förra slutet + 1 dag) + n månader − 1 dag.
 *   Är det uppsagt (`terminatedOn`) slutar det vid den första periodens slut vars sista
 *   uppsägningsdag är samma dag som eller efter uppsägningen.
 * - Översikten räknar nettointäkten (alla order, domänens lönsamhet per butik) de senaste
 *   12 månaderna (t.o.m. i går) per butik. Butikens gällande avtal i dag avgör kategorin:
 *   löper ut inom 12 månader, längre/tills vidare, eller inget gällande avtal.
 * - Ett redan tecknat efterföljande avtal (börjar senast dagen efter nuvarande periods slut)
 *   räknas in: påminnelsen för det gamla avtalet behövs inte (status 'scheduled', inte i `due`)
 *   om det inte förlängs automatiskt, och i översikten gäller butikens avtal till slutet på
 *   kedjan av avtal utan lucka (`coveredUntil`).
 */

import {
  addDays,
  addMonths,
  assertIsoDate,
  daysBetween,
  DomainError,
  monthEnd,
  NO_STORE_KEY,
  profitability,
  maxDate,
  ratioBp,
  type IsoDate,
  type Period,
} from "@/domain";
import { nameLookup } from "../todos/common";
import { pct, kr, plural } from "../todos/text";
import {
  addOre,
  assertCount,
  assertId,
  bpFigure,
  compareStrings,
  dateWithYear,
  daysFigure,
  financeEvidence,
  oreFigure,
  shiftMonths,
} from "../reconciliation/common";
import type {
  Contract,
  ContractReminder,
  ContractReminderInput,
  ContractReminderResult,
  ContractStatus,
  ContractTerm,
  ExpiringRevenueInput,
  ExpiringRevenueOverview,
  ExpiringStoreRow,
} from "./types";

/** Standardvärden. */
export const CONTRACT_DEFAULTS = {
  reminderLeadDays: 90,
  horizonMonths: 12,
  windowMonths: 12,
} as const;

const MAX_RENEWALS = 10_000;

/** Kontrollerar ett avtal. Kastar `DomainError` med svensk text. */
export function assertContract(c: Contract): void {
  const id = assertId(c?.id, "Avtalets id");
  assertId(c.storeId, `Butik för avtal ${id}`);
  assertIsoDate(c.validFrom, `Startdag för avtal ${id}`);
  if (c.validTo !== null) {
    assertIsoDate(c.validTo, `Slutdag för avtal ${id}`);
    if (c.validTo < c.validFrom) {
      throw new DomainError(
        "invalid_period",
        `Avtal ${id} slutar (${c.validTo}) före det börjar (${c.validFrom}).`,
      );
    }
  }
  if (c.noticeMonths != null)
    assertCount(c.noticeMonths, `Uppsägningstid (månader) för avtal ${id}`);
  if (c.noticeDays != null) assertCount(c.noticeDays, `Uppsägningstid (dagar) för avtal ${id}`);
  if (c.renewalMonths != null) {
    assertCount(c.renewalMonths, `Förlängning för avtal ${id}`);
    if (c.renewalMonths === 0) {
      throw new DomainError(
        "invalid_input",
        `Förlängningen för avtal ${id} måste vara minst 1 månad.`,
      );
    }
  }
  if (c.terminatedOn != null) assertIsoDate(c.terminatedOn, `Uppsägningsdag för avtal ${id}`);
}

/**
 * Sista dag att säga upp för att avtalet ska sluta `end`: slutet minus uppsägningstiden.
 * noticeDeadline('2027-03-31', 3) → '2026-12-31'; noticeDeadline('2027-06-30', 3) → '2027-03-31';
 * noticeDeadline('2027-06-15', 3) → '2027-03-15'; dagar dras därefter: (…, 0, 30).
 */
export function noticeDeadline(end: IsoDate, months = 0, days = 0): IsoDate {
  assertIsoDate(end, "Avtalets slut");
  assertCount(months, "Uppsägningstid (månader)");
  assertCount(days, "Uppsägningstid (dagar)");
  let d = end;
  if (months > 0) {
    const month = end.slice(0, 7);
    d = end === monthEnd(month) ? monthEnd(addMonths(month, -months)) : shiftMonths(end, -months);
  }
  return addDays(d, -days);
}

function noticeText(c: Contract): string {
  const m = c.noticeMonths ?? 0;
  const d = c.noticeDays ?? 0;
  const parts: string[] = [];
  if (m > 0) parts.push(m === 1 ? "1 månads" : `${m} månaders`);
  if (d > 0) parts.push(d === 1 ? "1 dags" : `${d} dagars`);
  return parts.length === 0 ? "ingen uppsägningstid" : `${parts.join(" och ")} uppsägningstid`;
}

/**
 * Avtalets nuvarande period i dag (`asOf`): slut efter eventuella automatiska förlängningar,
 * sista uppsägningsdag och påminnelsedag.
 */
export function contractTerm(
  contract: Contract,
  asOf: IsoDate,
  options: ContractReminderInput["options"] = {},
): ContractTerm {
  assertContract(contract);
  assertIsoDate(asOf, "I dag");
  const lead = assertCount(
    options?.reminderLeadDays ?? CONTRACT_DEFAULTS.reminderLeadDays,
    "Påminnelse (dagar)",
  );
  const basis = options?.reminderBasis ?? "notice-deadline";
  const months = contract.noticeMonths ?? 0;
  const days = contract.noticeDays ?? 0;
  const base = {
    contractId: contract.id,
    storeId: contract.storeId,
  };
  if (contract.validTo === null) {
    return {
      ...base,
      termStart: contract.validFrom,
      currentEnd: null,
      noticeDeadline: null,
      reminderDate: null,
      renews: false,
      nextEnd: null,
      renewals: 0,
    };
  }
  const renewal = contract.renewalMonths ?? null;
  const terminated = contract.terminatedOn ?? null;
  const anchor = addDays(contract.validTo, 1);
  const endOf = (k: number): IsoDate =>
    k === 0 ? contract.validTo! : addDays(shiftMonths(anchor, k * renewal!), -1);

  let k = 0;
  if (renewal !== null) {
    for (; k < MAX_RENEWALS; k++) {
      const end = endOf(k);
      const deadline = noticeDeadline(end, months, days);
      // Uppsagt i tid före denna periods sista uppsägningsdag: avtalet slutar här.
      if (terminated !== null && deadline >= terminated) break;
      // Inte uppsagt: perioden pågår (eller ligger framåt).
      if (end >= asOf) break;
    }
  }
  const currentEnd = endOf(k);
  const deadline = noticeDeadline(currentEnd, months, days);
  const renews = renewal !== null && !(terminated !== null && deadline >= terminated);
  const basisDate = basis === "end" ? currentEnd : deadline;
  return {
    ...base,
    termStart: k === 0 ? contract.validFrom : addDays(endOf(k - 1), 1),
    currentEnd,
    noticeDeadline: deadline,
    reminderDate: addDays(basisDate, -lead),
    renews,
    nextEnd: renews ? endOf(k + 1) : null,
    renewals: k,
  };
}

/** Status för avtalet i dag utifrån perioden. */
export function contractStatus(
  contract: Contract,
  term: ContractTerm,
  asOf: IsoDate,
): ContractStatus {
  if (asOf < contract.validFrom) return "not-started";
  if (term.currentEnd === null) return "open-ended";
  if (term.currentEnd < asOf) return "expired";
  if (contract.terminatedOn != null && contract.terminatedOn <= asOf && !term.renews)
    return "terminated";
  if (term.noticeDeadline !== null && asOf > term.noticeDeadline) return "notice-passed";
  if (term.reminderDate !== null && asOf >= term.reminderDate) return "due";
  return "scheduled";
}

/**
 * Ett redan tecknat efterföljande avtal för samma butik: ett annat avtal som börjar efter
 * detta avtals start, senast dagen efter nuvarande periods slut (ingen lucka), och som gäller
 * längre än nuvarande period (eller tills vidare). Finns flera väljs det som gäller längst,
 * sedan tidigast start och lägst id. `null` om avtalet gäller tills vidare eller inget finns.
 */
export function contractSuccessor(
  contract: Contract,
  term: ContractTerm,
  contracts: readonly Contract[],
  asOf: IsoDate,
  options: ContractReminderInput["options"] = {},
): { contract: Contract; term: ContractTerm } | null {
  if (term.currentEnd === null) return null;
  const end = term.currentEnd;
  const latestStart = addDays(end, 1);
  let best: { contract: Contract; term: ContractTerm } | null = null;
  for (const c of contracts) {
    if (c.id === contract.id || c.storeId !== contract.storeId) continue;
    if (c.validFrom <= contract.validFrom || c.validFrom > latestStart) continue;
    const t = contractTerm(c, maxDate(asOf, c.validFrom), options);
    if (t.currentEnd !== null && t.currentEnd <= end) continue;
    if (best === null) {
      best = { contract: c, term: t };
      continue;
    }
    const a = t.currentEnd ?? "9999-12-31";
    const b = best.term.currentEnd ?? "9999-12-31";
    if (
      a > b ||
      (a === b &&
        (c.validFrom < best.contract.validFrom ||
          (c.validFrom === best.contract.validFrom && c.id < best.contract.id)))
    ) {
      best = { contract: c, term: t };
    }
  }
  return best;
}

/**
 * Hur länge butiken har avtal utan lucka: följer kedjan av efterföljande avtal
 * (`contractSuccessor`) från ett avtal. `coveredUntil` = sista dagen med avtal (`null` = tills
 * vidare), `chain` = avtalen i kedjan (det första är avtalet självt) och `renews` = om det
 * sista avtalet förlängs automatiskt.
 */
export function contractCoverage(
  contract: Contract,
  term: ContractTerm,
  contracts: readonly Contract[],
  asOf: IsoDate,
): { coveredUntil: IsoDate | null; chain: Contract[]; renews: boolean } {
  const chain: Contract[] = [contract];
  let cur = { contract, term };
  for (let i = 0; i < contracts.length; i++) {
    const next = contractSuccessor(cur.contract, cur.term, contracts, asOf);
    if (next === null || chain.includes(next.contract)) break;
    chain.push(next.contract);
    cur = next;
  }
  return { coveredUntil: cur.term.currentEnd, chain, renews: cur.term.renews };
}

function statusOrder(r: ContractReminder): string {
  return r.term.noticeDeadline ?? r.term.currentEnd ?? "9999-12-31";
}

/**
 * Påminnelser för alla avtal: status i dag, sista uppsägningsdag och vad som händer annars.
 * `due` innehåller de som kräver något nu (påminnelsen har kommit, eller uppsägningstiden har
 * passerat för ett avtal som inte förlängs).
 */
export function contractReminders(input: ContractReminderInput): ContractReminderResult {
  assertIsoDate(input.asOf, "I dag");
  const { asOf } = input;
  const storeName = nameLookup(input.stores ?? []);
  const seen = new Set<string>();
  const reminders: ContractReminder[] = [];
  for (const c of input.contracts) {
    assertContract(c);
    if (seen.has(c.id)) throw new DomainError("invalid_input", `Avtal ${c.id} finns två gånger.`);
    seen.add(c.id);
    const term = contractTerm(c, asOf, input.options);
    const baseStatus = contractStatus(c, term, asOf);
    const store = storeName(c.storeId);
    const next =
      baseStatus === "due" || baseStatus === "notice-passed" || baseStatus === "scheduled"
        ? contractSuccessor(c, term, input.contracts, asOf, input.options)
        : null;
    // Ett nytt avtal är redan tecknat: det gamla behöver inte sägas upp eller omförhandlas,
    // om det inte förlängs automatiskt (då måste det fortfarande sägas upp).
    const replaced = next !== null && !term.renews;
    const status: ContractStatus = replaced ? "scheduled" : baseStatus;
    const daysToDeadline =
      term.noticeDeadline === null ? null : daysBetween(asOf, term.noticeDeadline);
    const daysToEnd = term.currentEnd === null ? null : daysBetween(asOf, term.currentEnd);
    const end = term.currentEnd === null ? "" : dateWithYear(term.currentEnd);
    const deadline = term.noticeDeadline === null ? "" : dateWithYear(term.noticeDeadline);
    const otherwise =
      term.renews && term.nextEnd
        ? ` Annars förlängs det med ${plural(c.renewalMonths!, "månad", "månader")} till ${dateWithYear(term.nextEnd)}.`
        : "";
    const nextText =
      next === null
        ? ""
        : `Nytt avtal${next.contract.name ? ` (${next.contract.name})` : ""} gäller från ${dateWithYear(
            next.contract.validFrom,
          )}${next.term.currentEnd === null ? " tills vidare" : ` till ${dateWithYear(next.term.currentEnd)}`}.`;
    let title: string;
    let detail: string;
    switch (replaced ? "replaced" : status) {
      case "replaced":
        title = `Avtalet med ${store} ersätts ${dateWithYear(next!.contract.validFrom)}`;
        detail = `Nuvarande avtal slutar ${end}. ${nextText}`;
        break;
      case "not-started":
        title = `Avtalet med ${store} börjar ${dateWithYear(c.validFrom)}`;
        detail = term.currentEnd === null ? "Det gäller tills vidare." : `Det löper till ${end}.`;
        break;
      case "open-ended":
        title = `Avtalet med ${store} gäller tills vidare`;
        detail = `${noticeText(c).charAt(0).toLocaleUpperCase("sv-SE")}${noticeText(c).slice(1)}.`;
        break;
      case "expired":
        title = `Avtalet med ${store} gick ut ${end}`;
        detail = `Det har gått ${plural(-daysToEnd!, "dag", "dagar")}. Teckna ett nytt avtal eller flytta automaten.`;
        break;
      case "terminated":
        title = `Avtalet med ${store} är uppsagt och upphör ${end}`;
        detail = `Om ${plural(daysToEnd!, "dag", "dagar")}. Planera flytt av automaten eller ett nytt avtal.`;
        break;
      case "notice-passed":
        title = term.renews
          ? `Avtalet med ${store} förlängs till ${dateWithYear(term.nextEnd!)}`
          : `Avtalet med ${store} löper ut ${end}`;
        detail = term.renews
          ? `Sista dag att säga upp var ${deadline} (${noticeText(c)}). Nuvarande period slutar ${end}.`
          : `Sista dag att säga upp var ${deadline}. Avtalet slutar om ${plural(
              daysToEnd!,
              "dag",
              "dagar",
            )}; förhandla ett nytt avtal före dess.`;
        break;
      case "due":
        title = `Avtalet med ${store} löper ut ${end}`;
        detail =
          next !== null
            ? `${nextText} Säg upp det här avtalet senast ${deadline} (${noticeText(c)}), om ${plural(
                daysToDeadline!,
                "dag",
                "dagar",
              )}, så att det inte förlängs.`
            : `Säg upp eller omförhandla senast ${deadline} (${noticeText(c)}), om ${plural(
                daysToDeadline!,
                "dag",
                "dagar",
              )}.${otherwise}`;
        break;
      case "scheduled":
        title = `Avtalet med ${store} löper ut ${end}`;
        detail = `Påminnelse ${dateWithYear(term.reminderDate!)}. Sista dag att säga upp: ${deadline} (${noticeText(c)}).${otherwise}`;
        break;
    }
    reminders.push({
      key: `contract:${c.id}:${term.currentEnd ?? "open"}`,
      fingerprint: `${status}|${term.currentEnd ?? ""}|${term.noticeDeadline ?? ""}|${
        next?.contract.id ?? ""
      }`,
      contractId: c.id,
      storeId: c.storeId,
      status,
      term,
      successor:
        next === null
          ? null
          : {
              contractId: next.contract.id,
              validFrom: next.contract.validFrom,
              currentEnd: next.term.currentEnd,
            },
      daysToDeadline,
      daysToEnd,
      title,
      detail,
      evidence: financeEvidence({
        rule: `Sista uppsägningsdag = avtalets slut − uppsägningstid; påminnelse ${
          input.options?.reminderLeadDays ?? CONTRACT_DEFAULTS.reminderLeadDays
        } dagar före ${input.options?.reminderBasis === "end" ? "avtalets slut" : "sista uppsägningsdag"}.`,
        period: term.currentEnd === null ? null : { start: term.termStart, end: term.currentEnd },
        storeIds: [c.storeId],
        contractIds: next === null ? [c.id] : [c.id, next.contract.id],
        dates: [term.currentEnd, term.noticeDeadline, term.reminderDate].filter(
          (d): d is IsoDate => d !== null,
        ),
        figures: [
          ...(daysToDeadline === null
            ? []
            : [daysFigure("daysToDeadline", "Dagar till sista uppsägningsdag", daysToDeadline)]),
          ...(daysToEnd === null
            ? []
            : [daysFigure("daysToEnd", "Dagar till avtalets slut", daysToEnd)]),
        ],
      }),
    });
  }
  reminders.sort(
    (a, b) =>
      compareStrings(statusOrder(a), statusOrder(b)) || compareStrings(a.contractId, b.contractId),
  );
  const due = reminders.filter(
    (r) => r.status === "due" || (r.status === "notice-passed" && !r.term.renews),
  );
  const expired = reminders.filter((r) => r.status === "expired").length;
  const parts: string[] = [];
  if (due.length === 0) parts.push("Inget avtal behöver sägas upp eller omförhandlas nu.");
  else {
    const first = due[0]!;
    parts.push(
      `${plural(due.length, "avtal", "avtal")} behöver åtgärdas. Först: ${first.title.charAt(0).toLocaleLowerCase("sv-SE")}${first.title.slice(1)}${
        first.status === "due" ? `, säg upp senast ${dateWithYear(first.term.noticeDeadline!)}` : ""
      }.`,
    );
  }
  if (expired > 0) parts.push(`${plural(expired, "avtal", "avtal")} har gått ut.`);
  return { reminders, due, summary: parts.join(" ") };
}

/**
 * Hur stor del av intäkten de senaste 12 månaderna som ligger på avtal som löper ut inom
 * 12 månader. Fönstret slutar i går (`asOf` − 1) och börjar samma dag 12 månader före `asOf`:
 * asOf 2 nov. 2026 → 2 nov. 2025 – 1 nov. 2026. Intäkten per butik är domänens nettointäkt
 * per butik (alla order, även de utan inköpspris), med den placering som gällde varje dag.
 */
export function expiringRevenueOverview(input: ExpiringRevenueInput): ExpiringRevenueOverview {
  assertIsoDate(input.asOf, "I dag");
  const { asOf } = input;
  const horizonMonths = assertCount(
    input.horizonMonths ?? CONTRACT_DEFAULTS.horizonMonths,
    "Horisont (månader)",
  );
  const windowMonths = assertCount(
    input.windowMonths ?? CONTRACT_DEFAULTS.windowMonths,
    "Fönster (månader)",
  );
  if (windowMonths < 1)
    throw new DomainError("invalid_input", "Fönstret måste vara minst 1 månad.");
  const window: Period = { start: shiftMonths(asOf, -windowMonths), end: addDays(asOf, -1) };
  const horizonEnd = shiftMonths(asOf, horizonMonths);
  const storeName = nameLookup(input.stores ?? []);

  const byStore = profitability(
    {
      orders: input.orders,
      prices: input.prices,
      agreements: input.agreements,
      placements: input.placements,
      settings: input.settings,
      period: window,
    },
    "store",
  );
  const revenue = new Map<string, number>();
  let noStore = 0;
  for (const r of byStore.rows) {
    const value = r.revenueOre + r.unpricedRevenueOre;
    if (r.kind === "item") revenue.set(r.key, value);
    else if (r.key === NO_STORE_KEY) noStore = addOre(noStore, value);
  }
  const total = byStore.totals.revenueOre + byStore.totals.unpricedRevenueOre;

  // Gällande avtal per butik i dag: senaste start bland dem som börjat och inte gått ut.
  const current = new Map<string, { contract: Contract; term: ContractTerm }>();
  const seen = new Set<string>();
  const sorted = [...input.contracts].sort((a, b) => compareStrings(a?.id ?? "", b?.id ?? ""));
  for (const c of sorted) {
    assertContract(c);
    if (seen.has(c.id)) throw new DomainError("invalid_input", `Avtal ${c.id} finns två gånger.`);
    seen.add(c.id);
    if (c.validFrom > asOf) continue;
    const term = contractTerm(c, asOf);
    if (term.currentEnd !== null && term.currentEnd < asOf) continue;
    const prev = current.get(c.storeId);
    if (!prev || c.validFrom > prev.contract.validFrom)
      current.set(c.storeId, { contract: c, term });
  }

  const storeIds = [...new Set([...revenue.keys(), ...current.keys()])].sort(compareStrings);
  const rows: ExpiringStoreRow[] = storeIds.map((storeId) => {
    const value = revenue.get(storeId) ?? 0;
    const cur = current.get(storeId) ?? null;
    const coverage = cur === null ? null : contractCoverage(cur.contract, cur.term, sorted, asOf);
    const coveredUntil = coverage?.coveredUntil ?? null;
    const chainIds = coverage?.chain.map((c) => c.id) ?? [];
    const category =
      cur === null
        ? "no-contract"
        : coveredUntil !== null && coveredUntil <= horizonEnd
          ? "expiring"
          : "secure";
    const shareBp = ratioBp(value, total);
    return {
      storeId,
      category,
      contractId: cur?.contract.id ?? null,
      revenueOre: value,
      shareBp,
      currentEnd: cur?.term.currentEnd ?? null,
      coveredUntil,
      successorIds: chainIds.slice(1),
      noticeDeadline: cur?.term.noticeDeadline ?? null,
      renews: coverage?.renews ?? false,
      evidence: financeEvidence({
        rule:
          category === "expiring"
            ? "Butikens gällande avtal, och redan tecknade avtal som tar vid utan lucka, löper ut inom horisonten."
            : category === "secure"
              ? "Butikens gällande avtal, eller ett redan tecknat avtal som tar vid utan lucka, löper längre än horisonten eller tills vidare."
              : "Butiken har intäkt men inget gällande avtal i dag.",
        period: window,
        storeIds: [storeId],
        contractIds: chainIds,
        dates: [cur?.term.currentEnd ?? null, coveredUntil].filter((d): d is IsoDate => d !== null),
        figures: [
          oreFigure("revenueOre", "Nettointäkt i fönstret", value),
          ...(shareBp === null ? [] : [bpFigure("shareBp", "Andel av intäkten", shareBp)]),
        ],
      }),
    };
  });
  rows.sort((a, b) => b.revenueOre - a.revenueOre || compareStrings(a.storeId, b.storeId));

  const sumOf = (pred: (r: ExpiringStoreRow) => boolean): number =>
    rows.filter(pred).reduce((s, r) => addOre(s, r.revenueOre), 0);
  const expiring = sumOf((r) => r.category === "expiring");
  const renewing = sumOf((r) => r.category === "expiring" && r.renews);
  const noContract = sumOf((r) => r.category === "no-contract");
  const expiringShareBp = ratioBp(expiring, total);
  const noContractShareBp = ratioBp(noContract, total);

  const parts: string[] = [];
  const expiringRows = rows.filter((r) => r.category === "expiring" && r.revenueOre > 0);
  if (total === 0) {
    parts.push("Ingen intäkt de senaste 12 månaderna.");
  } else if (expiringRows.length === 0) {
    parts.push(`Inget avtal med intäkt löper ut före ${dateWithYear(horizonEnd)}.`);
  } else {
    const list = expiringRows
      .slice(0, 3)
      .map(
        (r) =>
          `${storeName(r.storeId)} ${pct(r.shareBp ?? 0)} (slutar ${dateWithYear(r.coveredUntil!)})`,
      )
      .join(", ");
    parts.push(
      `${pct(expiringShareBp ?? 0)} av intäkten de senaste ${windowMonths} månaderna (${kr(expiring)} av ${kr(
        total,
      )}) ligger på avtal som löper ut inom ${horizonMonths} månader: ${list}${expiringRows.length > 3 ? " m.fl." : ""}.`,
    );
    if (renewing > 0) {
      parts.push(`${kr(renewing)} av det förlängs automatiskt om ingen säger upp.`);
    }
  }
  const noContractRows = rows.filter((r) => r.category === "no-contract" && r.revenueOre > 0);
  if (noContractRows.length > 0) {
    parts.push(
      `${kr(noContract)} (${pct(noContractShareBp ?? 0)}) kommer från butiker utan gällande avtal: ${noContractRows
        .map((r) => storeName(r.storeId))
        .join(", ")}.`,
    );
  }

  return {
    window,
    horizonEnd,
    totalRevenueOre: total,
    expiringRevenueOre: expiring,
    expiringShareBp,
    renewingRevenueOre: renewing,
    noContractRevenueOre: noContract,
    noContractShareBp,
    noStoreRevenueOre: noStore,
    stores: rows,
    summary: parts.join(" "),
    evidence: financeEvidence({
      rule: "Andel = nettointäkt i butiker vars gällande avtal löper ut inom horisonten / all nettointäkt i fönstret.",
      period: window,
      storeIds: expiringRows.map((r) => r.storeId),
      contractIds: expiringRows.flatMap((r) =>
        r.contractId ? [r.contractId, ...r.successorIds] : [],
      ),
      dates: [horizonEnd],
      figures: [
        oreFigure("totalRevenueOre", "Nettointäkt i fönstret", total),
        oreFigure("expiringRevenueOre", "På avtal som löper ut", expiring),
        ...(expiringShareBp === null
          ? []
          : [bpFigure("expiringShareBp", "Andel som löper ut", expiringShareBp)]),
        oreFigure("noContractRevenueOre", "Utan gällande avtal", noContract),
        oreFigure("noStoreRevenueOre", "Utan butik", noStore),
      ],
    }),
  };
}
