/**
 * Startklar: vad som saknas innan en automat är helt inlagd, räknat ur datan.
 *
 * Ren funktion utan databas (testas i machine-ready.test.ts). Fakta läses under RLS i
 * ./machine-ready-load.ts. Inget bockas av för hand: ett steg är klart när datan finns.
 *
 * Stegen, i fast ordning:
 *   1. butik    Står i en butik (i dag eller från ett senare datum).
 *   2. avtal    Butiken har avtal den dagen (samma uppslag som beräkningarna: agreementOn).
 *   3. fack     Awish har läst facken. Utan Awish: lagret är inlagt.
 *   4. antal    Varje titel i automaten har antal per fack från Awish (bara med Awish).
 *   5. pris     Varje titel i automaten har inköpspris.
 *   6. kostnad  Vad automaten kostade är inlagt (machine_investments).
 *   7. kop      Första köpet har kommit.
 *
 * "Ansvarig" och "Fylls på från" är inga steg: tomt betyder där "Båda" och standardlagret,
 * och det går inte att skilja från ett val. De ärvs i stället från senaste automaten när en
 * ny kopplas (inheritFromLastMachine i src/server/machines/new-machines.ts).
 *
 * "Nästa" är första steget som ägaren själv kan göra. Steg som bara går att vänta på
 * (Awish läser facken, första köpet) blir "Nästa" först när inget annat är kvar.
 */

import { agreementOn, type IsoDate, type StoreAgreement } from "@/domain";
import { formatInt, NBSP } from "@/lib/format";

export type ReadyStepId = "butik" | "avtal" | "fack" | "antal" | "pris" | "kostnad" | "kop";

/** En titel som står i automaten (saldo över 0 eller ett fack i Awish). */
export interface ReadyTitle {
  readonly id: string;
  readonly name: string;
  /** Antal per fack är läst från Awish. */
  readonly hasCapacity: boolean;
  /** Titeln har ett inköpspris som gäller i dag. */
  readonly hasPrice: boolean;
}

/** Det som läses ur databasen för en automat. */
export interface MachineReadyFacts {
  readonly machineId: string;
  readonly code: string;
  readonly today: IsoDate;
  /** Butiken automaten står i (eller ska stå i), och från vilken dag. */
  readonly store: { readonly id: string; readonly name: string; readonly from: IsoDate } | null;
  /** Butikens avtal (alla, även gamla och kommande). */
  readonly agreements: readonly StoreAgreement[];
  /** Automaten är kopplad till Awish. */
  readonly awish: boolean;
  /** Senaste gången Awish läste facken (ISO), eller null. */
  readonly slotsReadAt: string | null;
  readonly titles: readonly ReadyTitle[];
  /** Summan av det som lagts in som automatens kostnad, i öre. */
  readonly investmentOre: number;
  readonly firstOrderDate: IsoDate | null;
}

export interface ReadyStep {
  readonly id: ReadyStepId;
  /** Raden i listan: "Butiken har avtal". */
  readonly label: string;
  readonly done: boolean;
  /** Grå text under raden: vad som finns eller saknas. */
  readonly detail: string | null;
  /** Fortsättningen på "Nästa: …", med liten bokstav. */
  readonly next: string;
  /** Dit raden går (rätt formulär), eller null när det inte finns något att trycka på. */
  readonly href: string | null;
  /** Går bara att vänta på (Awish, första köpet). */
  readonly waiting: boolean;
}

export interface MachineReadiness {
  readonly machineId: string;
  readonly code: string;
  readonly done: number;
  readonly total: number;
  /** Allt är klart: listan visas inte. */
  readonly complete: boolean;
  readonly steps: readonly ReadyStep[];
  /** Steget att göra nu, eller null när allt är klart. */
  readonly next: ReadyStep | null;
  /** "BL-004: 3 av 7 klart. Nästa: lägg in avtalet." */
  readonly headline: string;
  /** "3 av 7 klart" */
  readonly progress: string;
  /** "2 saker kvar", eller null när allt är klart. */
  readonly left: string | null;
}

function names(list: readonly string[]): string {
  const [first, second, ...rest] = list;
  if (first === undefined) return "";
  if (second === undefined) return first;
  if (rest.length === 0) return `${first} och ${second}`;
  return `${first} och ${formatInt(list.length - 1)}${NBSP}till`;
}

function machinePath(code: string): string {
  return `/automater/${encodeURIComponent(code.toLowerCase())}`;
}

/** Stegen för en automat. Ren. */
export function machineReadiness(facts: MachineReadyFacts): MachineReadiness {
  const { code, store, titles, today } = facts;
  const page = machinePath(code);
  const steps: ReadyStep[] = [];

  steps.push({
    id: "butik",
    label: "Står i en butik",
    done: store !== null,
    detail: store ? store.name : "Ingen butik vald.",
    next: "välj butik",
    href: `${page}?gor=placera`,
    waiting: false,
  });

  // Avtalet ska gälla dagen automaten står där: i dag, eller första dagen om den är senare.
  const day = store && store.from > today ? store.from : today;
  const agreement = store ? agreementOn(facts.agreements, store.id, day) : null;
  const later = store
    ? facts.agreements.some((a) => a.storeId === store.id && a.validFrom > day)
    : false;
  steps.push({
    id: "avtal",
    label: "Butiken har avtal",
    done: agreement !== null,
    detail: !store
      ? "Välj butik först."
      : agreement
        ? null
        : later
          ? `Avtalet med ${store.name} har inte börjat. Butiken räknas som 0${NBSP}% till dess.`
          : `${store.name} har inget avtal. Butiken räknas som 0${NBSP}%.`,
    next: "lägg in avtalet",
    href: store ? `/butiker/${store.id}#ersattning` : `${page}?gor=placera`,
    waiting: false,
  });

  if (facts.awish) {
    const read = facts.slotsReadAt !== null;
    steps.push({
      id: "fack",
      label: "Awish har läst facken",
      done: read,
      detail: read ? null : "Awish läser facken inom några minuter.",
      next: "vänta på att Awish läser facken",
      href: null,
      waiting: true,
    });
    const without = titles.filter((t) => !t.hasCapacity).map((t) => t.name);
    steps.push({
      id: "antal",
      label: "Facken har antal",
      done: read && titles.length > 0 && without.length === 0,
      detail: !read
        ? "Kommer när Awish har läst facken."
        : titles.length === 0
          ? "Automaten har inga titlar i facken än."
          : without.length > 0
            ? `Antal per fack saknas för ${names(without)}. Det ställs in i Awish.`
            : null,
      next: "lägg in antal per fack i Awish",
      href: read ? `${page}?vy=lager` : null,
      waiting: !read,
    });
  } else {
    steps.push({
      id: "fack",
      label: "Lagret är inlagt",
      done: titles.length > 0,
      detail: titles.length > 0 ? null : "Inga pack är inlagda i automaten.",
      next: "lägg in vad som står i automaten",
      href: "/lager",
      waiting: false,
    });
  }

  const unpriced = titles.filter((t) => !t.hasPrice).map((t) => t.name);
  steps.push({
    id: "pris",
    label: "Inköpspris på allt i automaten",
    done: titles.length > 0 && unpriced.length === 0,
    detail:
      titles.length === 0
        ? "Kommer när automaten har titlar."
        : unpriced.length > 0
          ? `Saknas för ${names(unpriced)}.`
          : null,
    next: "lägg in inköpspris",
    href: titles.length > 0 ? "/inkopspriser?saknar=pris" : null,
    waiting: titles.length === 0,
  });

  steps.push({
    id: "kostnad",
    label: "Vad automaten kostade",
    done: facts.investmentOre > 0,
    detail: facts.investmentOre > 0 ? null : "Behövs för att se när automaten har betalat sig.",
    next: "lägg in vad automaten kostade",
    href: `/automater/enhetsekonomi?automat=${facts.machineId}&ny=1#investeringar`,
    waiting: false,
  });

  steps.push({
    id: "kop",
    label: "Första köpet",
    done: facts.firstOrderDate !== null,
    detail: facts.firstOrderDate !== null ? null : "Inget köp än.",
    next: "vänta på första köpet",
    href: null,
    waiting: true,
  });

  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  const open = steps.filter((s) => !s.done);
  const next = open.find((s) => !s.waiting) ?? open[0] ?? null;
  const progress = `${formatInt(done)} av ${formatInt(total)} klart`;
  return {
    machineId: facts.machineId,
    code,
    done,
    total,
    complete: open.length === 0,
    steps,
    next,
    progress,
    headline: next ? `${code}: ${progress}. Nästa: ${next.next}.` : `${code}: allt är klart.`,
    left:
      open.length === 0
        ? null
        : `${formatInt(open.length)}${NBSP}${open.length === 1 ? "sak" : "saker"} kvar`,
  };
}

/** "2 saker kvar" per automat, bara för dem som inte är klara. */
export function readinessLeft(list: readonly MachineReadiness[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of list) if (r.left) out[r.machineId] = r.left;
  return out;
}
