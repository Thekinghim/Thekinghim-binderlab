/**
 * Daglig kontroll: Binderlab kontrollerar sina egna siffror (en gång om dagen och med
 * "Kör kontrollen nu"). Varje kontroll är en ren funktion av redan inlästa tal (den här
 * mappen); inläsningen och larmen ligger i src/server/self-check.
 *
 *   samma_vinst       vinst och marginal är samma på Hem, Lönsamhet, Automater, Butiker
 *                     och Värde, med och utan butikernas andel, och andelen är det
 *                     avräkningarna räknar
 *   awish_appen       Awish fack = appens saldo i automaten
 *   pafyllning_awish  påfyllningar i appen har skickats till Awish
 *   synk              orderna och facken läses från Awish i tid, kontot går inte ut
 *   avrakningar       obetalda avräkningar = butikens andel på sidorna
 *   datahygien        order utan titel eller belopp, sålda titlar utan inköpspris,
 *                     negativt saldo
 *   installningar     kortavgift 0 % trots kortköp, moms 0 % nära momsgränsen (varningar)
 *
 * Resultatet sparas i public.self_check_runs.checks (jsonb), därför bara enkla värden.
 */

export type SelfCheckId =
  | "samma_vinst"
  | "awish_appen"
  | "pafyllning_awish"
  | "synk"
  | "avrakningar"
  | "datahygien"
  | "installningar";

/** pass = gick igenom, warn = varning (inget larm), fail = fel (larm), skip = inget att kontrollera. */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckFinding {
  readonly level: "fail" | "warn";
  /** En mening på enkel svenska med talen. */
  readonly text: string;
  /** Sidan där det rättas (relativ sökväg), om en annan än kontrollens. */
  readonly link?: string;
}

export interface CheckFigure {
  readonly label: string;
  readonly value: number;
  readonly unit: "ore" | "bp" | "count" | "minutes";
}

export interface CheckResult {
  readonly id: SelfCheckId;
  readonly status: CheckStatus;
  /** Kontrollens namn, t.ex. "Samma vinst överallt". */
  readonly title: string;
  /** En mening: vad som kontrollerades och hur det gick. */
  readonly summary: string;
  /** Det som inte stämde (högst MAX_FINDINGS; `more` säger hur många till). */
  readonly findings: readonly CheckFinding[];
  readonly more: number;
  readonly figures: readonly CheckFigure[];
  /** Sidan där felen rättas och dess namn. */
  readonly link: string;
  readonly linkLabel: string;
  /** Tid för kontrollen i ms (sätts av körningen). */
  readonly durationMs?: number;
}

/** Fler fynd än så sparas inte per kontroll (resten räknas i `more`). */
export const MAX_FINDINGS = 20;

export interface CheckMeta {
  readonly title: string;
  readonly link: string;
  readonly linkLabel: string;
}

/** Namn och sida per kontroll, i den ordning de visas. */
export const CHECKS: Readonly<Record<SelfCheckId, CheckMeta>> = {
  samma_vinst: { title: "Samma vinst överallt", link: "/lonsamhet", linkLabel: "Lönsamhet" },
  awish_appen: { title: "Awish = appen", link: "/lager", linkLabel: "Lager" },
  pafyllning_awish: {
    title: "Påfyllningar nådde Awish",
    link: "/datakallor",
    linkLabel: "Datakällor",
  },
  synk: { title: "Synk färsk", link: "/datakallor", linkLabel: "Datakällor" },
  avrakningar: { title: "Avräkningar", link: "/butiker", linkLabel: "Butiker" },
  datahygien: { title: "Datahygien", link: "/inkopspriser", linkLabel: "Inköpspriser" },
  installningar: { title: "Inställningar", link: "/installningar", linkLabel: "Inställningar" },
};

export const CHECK_ORDER: readonly SelfCheckId[] = [
  "samma_vinst",
  "awish_appen",
  "pafyllning_awish",
  "synk",
  "avrakningar",
  "datahygien",
  "installningar",
];

export function isSelfCheckId(value: unknown): value is SelfCheckId {
  return typeof value === "string" && (CHECK_ORDER as readonly string[]).includes(value);
}
