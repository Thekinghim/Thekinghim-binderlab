/**
 * Vakten: det som måste synas när appen själv har slutat fungera.
 *
 * Larmen och den dagliga kontrollen körs av schemalagda jobb. När ett jobb inte körs säger
 * det ingenting: sidorna ser ut som vanligt, med gårdagens tal. Vakten räknar därför ut
 * läget ur det som faktiskt står i databasen (senaste körningen, senaste lyckade
 * hämtningen, vem som nås av ett larm), varje gång Hem eller Drift öppnas och varje gång
 * ett jobb som går kör. Inget här beror på att just det jobb som har stannat rapporterar.
 *
 *   ingen nås av larm          "Ingen får larm just nu"
 *   kontrollen har inte körts  "Kontrollen har inte körts sedan …"
 *   hämtningen står still      "Försäljningen har inte hämtats sedan …"
 *   larmen har inte setts över "Larmen har inte kontrollerats sedan …"
 *   Awish per väg              "Lagret har inte lästs sedan …" m.fl. (./awish.ts)
 *
 * Rent: inga anrop, ingen klocka. Texterna är enkel svenska, det viktigaste först.
 */

import { awishLines, type AwishWatchFacts } from "./awish";

export * from "./awish";

export type WatchLevel = "critical" | "warning";

export interface WatchLine {
  /** Stabil nyckel: också larmets incidentnyckel (`watch:<key>`) när raden larmar. */
  readonly key: string;
  readonly level: WatchLevel;
  /** Vad som är fel, en mening. */
  readonly title: string;
  /** Vad det betyder och vad man gör. */
  readonly detail: string;
  readonly href: string;
  /** Länkens text, t.ex. "Slå på notiser". */
  readonly action: string;
}

/** Formaterar en tidpunkt som den visas ("i dag 05:37", "17 nov. 05:37"). */
export type WhenText = (iso: string) => string;

// ---------------------------------------------------------------------------
// Vem nås av ett larm?
// ---------------------------------------------------------------------------

/** En ägare eller admin och kanalerna hen har valt. */
export interface ReachMember {
  readonly active: boolean;
  readonly channels: readonly string[];
  readonly hasEmail: boolean;
  readonly hasPhone: boolean;
  /** Push-enheter som inte är avstängda. */
  readonly devices: number;
}

/** Vilka kanaler som går att skicka i härifrån. */
export interface ChannelsWorking {
  readonly email: boolean;
  readonly push: boolean;
  readonly sms: boolean;
}

/** Nås personen av ett larm i någon kanal som fungerar? */
export function memberReached(m: ReachMember, works: ChannelsWorking): boolean {
  if (!m.active) return false;
  return (
    (m.channels.includes("email") && works.email && m.hasEmail) ||
    (m.channels.includes("push") && works.push && m.devices > 0) ||
    (m.channels.includes("sms") && works.sms && m.hasPhone)
  );
}

export interface ReachFacts {
  readonly members: readonly ReachMember[];
  readonly works: ChannelsWorking;
}

/** Antal ägare och admin som nås av ett larm. */
export function reachedCount(f: ReachFacts): number {
  return f.members.filter((m) => memberReached(m, f.works)).length;
}

/** "Ingen får larm just nu", eller null när minst en ägare eller admin nås. */
export function reachLine(f: ReachFacts): WatchLine | null {
  if (reachedCount(f) > 0) return null;
  const detail = f.works.push
    ? f.works.email
      ? "Larmen syns bara här i appen. Slå på notiser på din telefon eller välj e-post."
      : "Larmen syns bara här i appen. Slå på notiser på din telefon, så får du dem direkt."
    : f.works.email
      ? "Larmen syns bara här i appen. Välj e-post under Notiser."
      : "Larmen syns bara här i appen. Varken notiser eller e-post är påslagna för Binderlab.";
  return {
    key: "larm-nar-ingen",
    level: "critical",
    title: "Ingen får larm just nu",
    detail,
    href: "/drift/larm",
    action: f.works.push ? "Slå på notiser" : "Öppna Notiser",
  };
}

// ---------------------------------------------------------------------------
// Jobben som ska ha kört
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Kontrollen körs en gång per dygn: efter så här länge utan körning är något fel. */
export const SELF_CHECK_MAX_AGE_HOURS = 26;
/** Larmen ses över minst en gång per dygn (och efter varje hämtning som kräver det). */
export const ALERT_RUN_MAX_AGE_HOURS = 26;
/** Hämtningen från Awish går var femte minut: efter så här länge utan lyckad hämtning. */
export const SYNC_MAX_AGE_MINUTES = 30;
/** Eller efter så här många misslyckade körningar i rad. */
export const SYNC_MAX_FAILURES = 3;

function olderThan(iso: string | null, now: Date, ms: number): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || now.getTime() - t > ms;
}

/** Vad schemat (pg_cron) fick till svar när det senast anropade jobbet. */
export interface CronAnswer {
  readonly calledAt: string;
  /** null = inget svar har kommit. */
  readonly statusCode: number | null;
  readonly timedOut: boolean;
}

/** "Schemat anropade den …, men …": varför jobbet inte kördes, så långt det går att se. */
export function cronAnswerText(a: CronAnswer | null | undefined, when: WhenText): string {
  if (!a) return "";
  const at = when(a.calledAt);
  if (a.timedOut) return ` Schemat anropade den ${at}, men fick inget svar i tid.`;
  if (a.statusCode === null) return ` Schemat anropade den ${at}, men fick inget svar.`;
  if (a.statusCode >= 200 && a.statusCode < 300) {
    return ` Schemat anropade den ${at} och fick svar, men ingen körning sparades.`;
  }
  return ` Schemat anropade den ${at}, men fick fel ${a.statusCode} till svar.`;
}

export interface SelfCheckFacts {
  /** Senaste schemalagda körningen (inte "Kör kontrollen nu"). */
  readonly lastScheduledAt: string | null;
  /** När organisationen skapades: en ny organisation har inget att sakna än. */
  readonly organizationCreatedAt: string;
  /** Senaste anropet från schemat och svaret (private.cron_calls), om det finns. */
  readonly lastCall?: CronAnswer | null;
}

/** "Kontrollen har inte körts sedan …", eller null när den har kört i tid. */
export function selfCheckLine(f: SelfCheckFacts, now: Date, when: WhenText): WatchLine | null {
  const limit = SELF_CHECK_MAX_AGE_HOURS * HOUR_MS;
  if (!olderThan(f.lastScheduledAt, now, limit)) return null;
  if (!olderThan(f.organizationCreatedAt, now, limit)) return null;
  return {
    key: "kontroll",
    level: "critical",
    title: f.lastScheduledAt
      ? `Kontrollen har inte körts sedan ${when(f.lastScheduledAt)}`
      : "Kontrollen har aldrig körts av sig själv",
    detail: `Den ska köras varje morgon och jämföra siffrorna på alla sidor.${cronAnswerText(f.lastCall, when)} Kör den själv nu, och säg till den som sköter driften.`,
    href: "/installningar/kontroll",
    action: "Kör kontrollen nu",
  };
}

export interface SyncSourceFacts {
  readonly id: string;
  readonly name: string;
  /** Senaste lyckade hämtningen (order lästa utan fel). */
  readonly lastSuccessAt: string | null;
  /** Senaste försöket, lyckat eller inte. */
  readonly lastRunAt: string | null;
  /** Felet i senaste försöket (null när det gick bra). */
  readonly lastError: string | null;
  /** Misslyckade körningar i rad. */
  readonly failures: number;
  /** När källan kopplades: en ny källa har inget att sakna än. */
  readonly createdAt: string;
}

/** Har hämtningen stannat eller misslyckats för länge? */
export function syncBroken(f: SyncSourceFacts, now: Date): boolean {
  const limit = SYNC_MAX_AGE_MINUTES * MINUTE_MS;
  if (f.failures >= SYNC_MAX_FAILURES) return true;
  if (!olderThan(f.lastSuccessAt, now, limit)) return false;
  // Aldrig lyckad: räkna från att källan kopplades.
  return f.lastSuccessAt !== null || olderThan(f.createdAt, now, limit);
}

/** "Försäljningen har inte hämtats sedan …" för en källa, eller null. */
export function syncLine(f: SyncSourceFacts, now: Date, when: WhenText): WatchLine | null {
  if (!syncBroken(f, now)) return null;
  const since = f.lastSuccessAt
    ? `Försäljningen har inte hämtats sedan ${when(f.lastSuccessAt)}`
    : "Försäljningen har aldrig hämtats";
  const running = !olderThan(f.lastRunAt, now, SYNC_MAX_AGE_MINUTES * MINUTE_MS);
  const why = running
    ? f.lastError
      ? `Awish svarar med fel: ${f.lastError}`
      : "Hämtningen går men kommer inte fram till Awish."
    : "Hämtningen körs inte alls just nu.";
  // Det finns ingen annan väg till orderna: orderlistan från Awish (CSV) är reserven. Binderlab
  // hämtar resten själv när Awish svarar igen (inga order tappas, inga dubbletter).
  return {
    key: `synk:${f.id}`,
    level: "critical",
    title: since,
    detail: `${why} Försäljningen står still tills det fungerar igen. Ladda upp orderlistan från Awish i Datakällor så länge. Binderlab hämtar resten själv sedan.`,
    href: "/datakallor#ladda-upp",
    action: "Ladda upp orderlistan",
  };
}

export interface AlertRunFacts {
  readonly lastRunAt: string | null;
  readonly organizationCreatedAt: string;
}

/** "Larmen har inte kontrollerats sedan …", eller null. */
export function alertRunLine(f: AlertRunFacts, now: Date, when: WhenText): WatchLine | null {
  const limit = ALERT_RUN_MAX_AGE_HOURS * HOUR_MS;
  if (!olderThan(f.lastRunAt, now, limit)) return null;
  if (!olderThan(f.organizationCreatedAt, now, limit)) return null;
  return {
    key: "larmjobb",
    level: "critical",
    title: f.lastRunAt
      ? `Larmen har inte kontrollerats sedan ${when(f.lastRunAt)}`
      : "Larmen har aldrig kontrollerats",
    detail:
      "Automater som står still och fack som tar slut larmar inte förrän det fungerar igen. Säg till den som sköter driften.",
    href: "/drift",
    action: "Öppna Drift",
  };
}

// ---------------------------------------------------------------------------
// Hur gammal är datan per automat?
// ---------------------------------------------------------------------------

export interface MachineDataFacts {
  readonly machineId: string;
  readonly label: string;
  /** Senaste gången automaten sågs i en lyckad hämtning från Awish. */
  readonly seenAt: string | null;
}

export interface MachineAge {
  readonly machineId: string;
  readonly label: string;
  /** Minuter sedan automaten sågs; null = aldrig sedd. */
  readonly minutes: number | null;
  readonly stale: boolean;
  /** "3 min sedan", "2 tim sedan", "aldrig". */
  readonly text: string;
}

/** "3 min", "2 tim 10 min", "3 dygn". */
export function ageText(minutes: number): string {
  if (minutes < 1) return "nyss";
  if (minutes < 60) return `${minutes} min sedan`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 || h >= 6 ? `${h} tim sedan` : `${h} tim ${m} min sedan`;
  }
  return `${Math.floor(minutes / (24 * 60))} dygn sedan`;
}

/** Datans ålder per automat. Gammal = äldre än gränsen för hämtningen. */
export function machineAges(machines: readonly MachineDataFacts[], now: Date): MachineAge[] {
  return machines.map((m) => {
    const t = m.seenAt ? Date.parse(m.seenAt) : NaN;
    if (!Number.isFinite(t)) {
      return { machineId: m.machineId, label: m.label, minutes: null, stale: true, text: "aldrig" };
    }
    const minutes = Math.max(0, Math.floor((now.getTime() - t) / MINUTE_MS));
    return {
      machineId: m.machineId,
      label: m.label,
      minutes,
      stale: minutes > SYNC_MAX_AGE_MINUTES,
      text: ageText(minutes),
    };
  });
}

/**
 * Raden på Hem: "Data från Awish: alla 4 automater, 3 min sedan." eller, när någon släpar,
 * "Gammal data: BL-003 2 tim sedan. Övriga 3 min sedan."
 */
export function machineAgeSummary(ages: readonly MachineAge[]): {
  readonly stale: boolean;
  readonly text: string;
} | null {
  if (ages.length === 0) return null;
  const stale = ages.filter((a) => a.stale);
  const fresh = ages.filter((a) => !a.stale);
  const oldestFresh = fresh.reduce<number>((n, a) => Math.max(n, a.minutes ?? 0), 0);
  if (stale.length === 0) {
    return {
      stale: false,
      text:
        ages.length === 1
          ? `Data från Awish: ${ages[0]!.label}, ${ageText(oldestFresh)}.`
          : `Data från Awish: alla ${ages.length} automater, ${ageText(oldestFresh)}.`,
    };
  }
  const list = stale.map((a) => `${a.label} ${a.text}`).join(", ");
  return {
    stale: true,
    text:
      fresh.length === 0
        ? `Gammal data från Awish: ${list}.`
        : `Gammal data från Awish: ${list}. Övriga ${ageText(oldestFresh)}.`,
  };
}

// ---------------------------------------------------------------------------
// Allt samlat
// ---------------------------------------------------------------------------

export interface WatchFacts {
  /** null = räknas inte (t.ex. en demo, där inget skickas). */
  readonly reach: ReachFacts | null;
  readonly selfCheck: SelfCheckFacts | null;
  readonly sync: readonly SyncSourceFacts[];
  readonly alertRun: AlertRunFacts | null;
  /** Hälsan per Awish-väg (lager, automater, påfyllningar). Utelämnat = inga rader. */
  readonly awish?: AwishWatchFacts | null;
}

/** Raderna som ska visas, de allvarligaste först. */
export function watchLines(f: WatchFacts, now: Date, when: WhenText): WatchLine[] {
  const lines = [
    ...f.sync.map((s) => syncLine(s, now, when)),
    ...(f.awish ? awishLines(f.awish, now, when) : []),
    f.reach ? reachLine(f.reach) : null,
    f.alertRun ? alertRunLine(f.alertRun, now, when) : null,
    f.selfCheck ? selfCheckLine(f.selfCheck, now, when) : null,
  ];
  // Kritiska först; annars i ordningen ovan (sort är stabil).
  return lines
    .filter((l): l is WatchLine => l !== null)
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1));
}
