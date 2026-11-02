/**
 * Kom igång: checklistan för en ny organisation, räknad ur datan.
 *
 * Rena funktioner utan databas (testas i model.test.ts). Fakta läses i ./status.ts under
 * RLS och skickas hit. Inget steg bockas av för hand: ett steg är klart när datan finns.
 *
 * Panelen har det den behöver (complete) när det finns minst en butik, en automat, en
 * datakälla, en import med order och inköpspris för minst 90 % av intäkten. Avtalet med
 * butiken rekommenderas men krävs inte (en butik kan sakna ersättning).
 *
 * Tiden räknas från organisationens created_at till den tidpunkt då varje steg blev
 * klart (första radens created_at, importens finished_at och, för inköpspriserna, när
 * det pris som tog täckningen över gränsen lades in). Alla belopp och andelar räknas
 * med @/domain (vatOfGross, PriceIndex, ratioBp).
 */

import { PriceIndex, ratioBp, vatOfGross, type IsoDate, type PurchasePrice } from "@/domain";
import { formatInt, formatPercent, NBSP } from "@/lib/format";

/** Gränsen för inköpspriser: andel av intäkten (netto) med pris, i bp. */
export const PRICE_COVERAGE_TARGET_BP = 9_000;

export type OnboardingStepId =
  "organisation" | "butik" | "avtal" | "automat" | "datakalla" | "import" | "inkopspriser";

/** done: datan finns. todo: nästa att göra. waiting: väntar på ett tidigare steg. */
export type OnboardingStepState = "done" | "todo" | "waiting";

/** Intäkt grupperad per titel, affärsdag och belopp (antal order i gruppen). */
export interface RevenueGroup {
  readonly titleId: string | null;
  readonly businessDate: IsoDate;
  readonly amountOre: number;
  readonly orders: number;
}

export interface TimedPrice extends PurchasePrice {
  /** När priset lades in (ISO 8601). */
  readonly createdAt: string;
}

/** Det som läses ur databasen (./status.ts). Tider som ISO 8601. */
export interface OnboardingFacts {
  readonly organization: { readonly name: string; readonly createdAt: string };
  readonly stores: {
    readonly count: number;
    readonly firstAt: string | null;
  };
  readonly agreements: {
    readonly count: number;
    readonly firstAt: string | null;
    /** Äldsta aktiva butik utan något avtal (länkmål), annars äldsta butiken. */
    readonly targetStoreId: string | null;
  };
  readonly machines: {
    readonly count: number;
    readonly firstAt: string | null;
    /** Automater som står i en butik i dag. */
    readonly placed: number;
  };
  readonly dataSources: { readonly count: number; readonly firstAt: string | null };
  readonly imports: {
    /** Importer som lagt in minst en order. */
    readonly withOrders: number;
    /** När den första sådana importen blev klar. */
    readonly firstAt: string | null;
    /** Antal order i organisationen. */
    readonly orders: number;
  };
  readonly revenue: readonly RevenueGroup[];
  readonly prices: readonly TimedPrice[];
  readonly vatRateBp: number;
}

export interface OnboardingAction {
  readonly label: string;
  readonly href: string;
}

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  /** "01" … "07". */
  readonly number: string;
  readonly title: string;
  /** En mening om varför steget behövs. */
  readonly why: string;
  readonly state: OnboardingStepState;
  /** Krävs för att panelen ska ha det den behöver. */
  readonly required: boolean;
  /** Läget i siffror, räknat ur datan ("2 butiker, 1 med avtal."). */
  readonly detail: string;
  /** Vad steget väntar på (bara i läget waiting). */
  readonly waitingFor: string | null;
  /** När steget blev klart (ISO), annars null. */
  readonly doneAt: string | null;
  /** Tid från start till doneAt i ms, annars null. */
  readonly sinceStartMs: number | null;
  /** Åtgärden (ägare och admin). null när steget inte har någon. */
  readonly action: OnboardingAction | null;
}

export interface PriceCoverage {
  /** Nettointäkt (exkl. moms) för alla order, i öre. */
  readonly revenueOre: number;
  /** Nettointäkt för order med inköpspris, i öre. */
  readonly pricedRevenueOre: number;
  /** pricedRevenueOre / revenueOre i bp, null utan intäkt. */
  readonly pricedShareBp: number | null;
}

export interface OnboardingStatus {
  readonly organizationId: string;
  readonly organizationName: string;
  /** organizations.created_at (ISO). */
  readonly startedAt: string;
  /** Tidpunkten statusen räknades (ISO). */
  readonly now: string;
  /** Alla krävda steg är klara. */
  readonly complete: boolean;
  readonly requiredDone: number;
  readonly requiredTotal: number;
  readonly done: number;
  readonly steps: readonly OnboardingStep[];
  /** När det sista krävda steget blev klart (bara när complete). */
  readonly completedAt: string | null;
  /** completedAt − startedAt, eller now − startedAt medan det pågår. */
  readonly elapsedMs: number;
  readonly coverage: PriceCoverage;
  /** Första steget att göra, eller null. */
  readonly next: OnboardingStep | null;
}

// ---------------------------------------------------------------------------
// Täckning av inköpspriser
// ---------------------------------------------------------------------------

/**
 * Hur stor del av intäkten (netto, moms avräknad per order) som har ett inköpspris
 * den dag ordern lades. Order utan titel räknas som utan pris.
 */
export function priceCoverage(
  groups: readonly RevenueGroup[],
  prices: readonly PurchasePrice[] | PriceIndex,
  vatRateBp: number,
): PriceCoverage {
  const index = prices instanceof PriceIndex ? prices : new PriceIndex(prices);
  let revenue = 0;
  let priced = 0;
  for (const g of groups) {
    const net = (g.amountOre - vatOfGross(g.amountOre, vatRateBp)) * g.orders;
    revenue += net;
    if (g.titleId !== null && index.priceOn(g.titleId, g.businessDate) !== null) priced += net;
  }
  return { revenueOre: revenue, pricedRevenueOre: priced, pricedShareBp: ratioBp(priced, revenue) };
}

function reached(c: PriceCoverage): boolean {
  return c.pricedShareBp !== null && c.pricedShareBp >= PRICE_COVERAGE_TARGET_BP;
}

/**
 * När täckningen nådde gränsen: priserna läggs till i den ordning de lades in, och det
 * första pris som tar täckningen över gränsen ger tidpunkten. Ett nytt pris kan bara
 * göra fler order prissatta, så täckningen växer med varje pris och binärsökning räcker.
 * null om gränsen inte är nådd med alla priser.
 */
export function coverageReachedAt(
  groups: readonly RevenueGroup[],
  prices: readonly TimedPrice[],
  vatRateBp: number,
): string | null {
  const sorted = [...prices].sort((a, b) => cmp(a.createdAt, b.createdAt));
  const at = (k: number) => reached(priceCoverage(groups, sorted.slice(0, k), vatRateBp));
  if (!at(sorted.length)) return null;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo === 0 ? null : sorted[lo - 1]!.createdAt;
}

// ---------------------------------------------------------------------------
// Stegen
// ---------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

function latest(...values: Array<string | null>): string | null {
  const present = values.filter((v): v is string => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
}

function count(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** Andel i bp som procent med en decimal, avrundad nedåt: 8 996 bp blir 89,9 %, aldrig 90,0 %. */
export function coverageText(bp: number): string {
  return formatPercent(Math.floor(bp / 10) / 1000);
}

interface StepDraft {
  readonly id: OnboardingStepId;
  readonly title: string;
  readonly why: string;
  readonly required: boolean;
  readonly doneAt: string | null;
  readonly detail: string;
  readonly blockedBy: OnboardingStepId | null;
  readonly action: OnboardingAction | null;
}

const WAITING_TEXT: Record<OnboardingStepId, string> = {
  organisation: "Väntar på organisationen.",
  butik: "Väntar på en butik.",
  avtal: "Väntar på en butik.",
  automat: "Väntar på en automat.",
  datakalla: "Väntar på en datakälla.",
  import: "Väntar på en datakälla.",
  inkopspriser: "Väntar på importerade order.",
};

/** Checklistan ur fakta. `now` avgör hur länge en pågående onboarding har hållit på. */
export function buildOnboardingStatus(
  organizationId: string,
  facts: OnboardingFacts,
  now: Date,
): OnboardingStatus {
  const startedAt = facts.organization.createdAt;
  const coverage = priceCoverage(facts.revenue, facts.prices, facts.vatRateBp);
  const importDone = facts.imports.withOrders > 0 ? facts.imports.firstAt : null;
  const pricesReachedAt =
    importDone && reached(coverage)
      ? latest(coverageReachedAt(facts.revenue, facts.prices, facts.vatRateBp), importDone)
      : null;

  const s = facts.stores;
  const a = facts.agreements;
  const m = facts.machines;
  const d = facts.dataSources;
  const i = facts.imports;

  const drafts: StepDraft[] = [
    {
      id: "organisation",
      title: "Skapa organisationen.",
      why: "Organisationen samlar butiker, automater, order och användare på ett ställe.",
      required: true,
      doneAt: startedAt,
      detail: `${facts.organization.name}.`,
      blockedBy: null,
      action: null,
    },
    {
      id: "butik",
      title: "Lägg till den första butiken.",
      why: "Butiken är platsen där automaten står, och ersättningen till butiken räknas per butik.",
      required: true,
      doneAt: s.count > 0 ? s.firstAt : null,
      detail: s.count > 0 ? `${count(s.count, "butik", "butiker")}.` : "Ingen butik ännu.",
      blockedBy: null,
      action: { label: "Lägg till butik", href: "/butiker" },
    },
    {
      id: "avtal",
      title: "Lägg in avtalet med butiken.",
      why: "Avtalet anger provision och hyra, som dras från vinsten varje månad.",
      required: false,
      doneAt: a.count > 0 ? a.firstAt : null,
      detail:
        a.count > 0
          ? `${count(a.count, "avtal", "avtal")} inlagda.`
          : s.count > 0
            ? `${count(s.count, "butik", "butiker")} utan avtal.`
            : "Inget avtal ännu.",
      blockedBy: "butik",
      action: {
        label: "Lägg in avtal",
        href: a.targetStoreId ? `/butiker/${a.targetStoreId}#ersattning` : "/butiker",
      },
    },
    {
      id: "automat",
      title: "Lägg till automaten.",
      why: "Varje order hör till en automat, och automaten till den butik där den står.",
      required: true,
      doneAt: m.count > 0 ? m.firstAt : null,
      detail:
        m.count > 0
          ? `${count(m.count, "automat", "automater")}, ${count(m.placed, "placerad", "placerade")} i en butik.`
          : "Ingen automat ännu.",
      blockedBy: null,
      action: { label: "Lägg till automat", href: "/automater" },
    },
    {
      id: "datakalla",
      title: "Koppla datakällan.",
      why: "Datakällan anger varifrån orderna kommer och i vilken tidszon de är stämplade.",
      required: true,
      doneAt: d.count > 0 ? d.firstAt : null,
      detail: d.count > 0 ? `${count(d.count, "källa", "källor")}.` : "Ingen datakälla ännu.",
      blockedBy: null,
      action: { label: "Koppla datakälla", href: "/datakallor#kallor" },
    },
    {
      id: "import",
      title: "Importera orderna.",
      why: "Nyckeltal, lager och lönsamhet räknas ur de importerade orderna.",
      required: true,
      doneAt: importDone,
      detail:
        i.withOrders > 0
          ? `${count(i.orders, "order", "order")} från ${count(i.withOrders, "import", "importer")}.`
          : "Inga order ännu.",
      blockedBy: "datakalla",
      action: { label: "Importera order", href: "/datakallor#ladda-upp" },
    },
    {
      id: "inkopspriser",
      title: "Ange inköpspriserna.",
      why: "En order utan inköpspris räknas inte in i vinsten, så vinsten blir bara rätt när priserna finns.",
      required: true,
      doneAt: pricesReachedAt,
      detail:
        coverage.pricedShareBp === null
          ? "Ingen intäkt att täcka ännu."
          : `${coverageText(coverage.pricedShareBp)} av intäkten har inköpspris, gränsen är ${coverageText(PRICE_COVERAGE_TARGET_BP)}.`,
      blockedBy: "import",
      action: { label: "Ange inköpspriser", href: "/inkopspriser?saknar=pris" },
    },
  ];

  const doneIds = new Set(drafts.filter((x) => x.doneAt !== null).map((x) => x.id));
  const start = Date.parse(startedAt);
  const steps: OnboardingStep[] = drafts.map((x, n) => {
    const done = x.doneAt !== null;
    const waiting = !done && x.blockedBy !== null && !doneIds.has(x.blockedBy);
    return {
      id: x.id,
      number: String(n + 1).padStart(2, "0"),
      title: x.title,
      why: x.why,
      state: done ? "done" : waiting ? "waiting" : "todo",
      required: x.required,
      detail: x.detail,
      waitingFor: waiting ? WAITING_TEXT[x.id] : null,
      doneAt: x.doneAt,
      sinceStartMs: x.doneAt ? Math.max(0, Date.parse(x.doneAt) - start) : null,
      action: x.action,
    };
  });

  const required = steps.filter((x) => x.required);
  const requiredDone = required.filter((x) => x.state === "done").length;
  const complete = requiredDone === required.length;
  const completedAt = complete ? latest(...required.map((x) => x.doneAt)) : null;
  const end = completedAt ? Date.parse(completedAt) : now.getTime();
  const next =
    steps.find((x) => x.required && x.state === "todo") ??
    steps.find((x) => x.state === "todo") ??
    null;

  return {
    organizationId,
    organizationName: facts.organization.name,
    startedAt,
    now: now.toISOString(),
    complete,
    requiredDone,
    requiredTotal: required.length,
    done: steps.filter((x) => x.state === "done").length,
    steps,
    completedAt,
    elapsedMs: Math.max(0, end - start),
    coverage,
    next,
  };
}
