/**
 * Sidans sammanhang för en fråga från AI-panelen: vilken sida användaren tittar på
 * (rutt och namn), period, filter på butik/automat, vyknappen "Med VMB" och vilken
 * automat/butik/titel en detaljsida visar. Plus de 2–3 förslagen (chips) per sida och
 * vilket verktyg som ger sidans sammanfattning till modellen.
 *
 * Ren modul utan serverkod: klienten bygger sammanhanget ur adressen (pageContextFromUrl),
 * servern validerar det igen (parsePageContext) och slår upp namn och siffror.
 */

import { activeRouteId, routeById, type Role, type RouteId } from "@/components/shell/nav";

export interface PageContext {
  readonly route: RouteId | null;
  /** Sökvägen utan frågesträng, högst 200 tecken. */
  readonly path: string;
  /** Skalets periodval (period, from, to) som i adressen. */
  readonly shell: Readonly<Record<string, string>>;
  readonly storeId: string | null;
  readonly machineId: string | null;
  readonly vmb: boolean;
  /** Detaljsidans automat (kod eller id), butik (id) eller titel (id). */
  readonly detail: { readonly kind: "automat" | "butik" | "titel"; readonly ref: string } | null;
}

export interface PageInfo {
  /** Sidans namn för användaren och modellen. */
  readonly name: string;
  /** En mening om vad sidan visar (till modellen). */
  readonly about: string;
  /** Förslag på frågor (chips), korta. {namn} byts mot detaljsidans namn. */
  readonly chips: readonly string[];
  /** Förslag för påfyllare (ser inga belopp). Saknas = inga. */
  readonly refillerChips?: readonly string[];
}

export const PAGE_INFO: Partial<Record<RouteId, PageInfo>> = {
  hem: {
    name: "Hem",
    about:
      "intäkt, vinst och marginal för perioden mot perioden före, dagsgrafen och det viktigaste att göra",
    chips: ["Varför ändrades vinsten?", "Vad ska jag göra i dag?", "Vilken automat tjänar mest?"],
  },
  "att-gora": {
    name: "Att göra",
    about: "punkterna som kräver åtgärd, mest brådskande först",
    chips: ["Vad är viktigast i dag?", "Vad kostar det om jag väntar?"],
    refillerChips: ["Vad är viktigast i dag?", "Vad ska jag ta med?"],
  },
  lonsamhet: {
    name: "Lönsamhet",
    about: "vinst, marginal och butiksersättning per automat, butik, titel och tid",
    chips: [
      "Varför gick vinsten ner?",
      "Vilken titel tjänar mest?",
      "Vilken butik har lägst marginal?",
    ],
  },
  order: {
    name: "Order",
    about: "varje order med tid, automat, titel och belopp",
    chips: ["När på dygnet säljer vi mest?", "Vilken veckodag är bäst?"],
  },
  lager: {
    name: "Lager",
    about: "saldo per automat och titel, packlistor och historik",
    chips: ["Vad behöver fyllas på i dag?", "Vad tar slut först?", "Hur länge räcker vårt lager?"],
    refillerChips: ["Vad behöver fyllas på i dag?", "Vad tar slut först?"],
  },
  "vart-lager": {
    name: "Vårt lager",
    about: "pack i centrallagret hemma per titel, räckvidd och veckans behov",
    chips: ["Hur länge räcker vårt lager?", "Vad ska jag beställa?"],
  },
  automater: {
    name: "Automater",
    about: "varje automat med intäkt, vinst, status och lager",
    chips: [
      "Vilken automat ska jag fylla på först?",
      "Vilken automat tjänar mest?",
      "Är någon automat tyst?",
    ],
  },
  butiker: {
    name: "Butiker",
    about: "varje butik med intäkt, vinst, butikens andel och avtal",
    chips: ["Hur mycket får {namn} i månaden?", "Vilken butik tjänar mest?"],
  },
  inkopspriser: {
    name: "Inköpspriser",
    about: "inköpspris, vad varje order lämnar och marginal per titel",
    chips: [
      "Vilka titlar går med förlust?",
      "Vilka titlar saknar inköpspris?",
      "Vilken titel har bäst marginal?",
    ],
  },
  prognos: {
    name: "Prognos & inköp",
    about: "försäljningsprognos, inköpsförslag, vårt lager och förlorad försäljning",
    chips: [
      "Vad ska jag beställa?",
      "Hur mycket säljer vi nästa vecka?",
      "Vad förlorade vi på slutsålt?",
    ],
  },
  drift: {
    name: "Drift",
    about: "status per automat, larm och veckans besöksplan",
    chips: ["Vilka automater ska jag besöka i veckan?", "Är någon automat tyst?"],
    refillerChips: ["Vilka automater ska jag besöka i veckan?", "Är någon automat tyst?"],
  },
  ekonomi: {
    name: "Ekonomi",
    about: "utbetalningar, avstämning, butikernas andel och bokföringens månader",
    chips: [
      "Vilken månad är klar att bokföra?",
      "Hur mycket får butikerna?",
      "Varför ändrades vinsten?",
    ],
  },
  avtal: {
    name: "Avtal",
    about: "butiksavtalen, villkor och när de går ut",
    chips: ["Vilka avtal går ut snart?", "Vilka villkor har butikerna?"],
  },
  rapporter: {
    name: "Rapporter",
    about: "månadsrapporter till butikerna",
    chips: ["Hur mycket får butikerna?", "Hur gick förra månaden?"],
  },
  datakallor: {
    name: "Datakällor",
    about: "synken från Awish och importer",
    chips: ["Fungerar synken från Awish?"],
  },
  assistent: {
    name: "Assistent",
    about: "samtalet med assistenten",
    chips: ["Hur gick förra veckan?", "Vad ska jag beställa?"],
    refillerChips: ["Vad behöver fyllas på i dag?"],
  },
};

const GENERIC: PageInfo = {
  name: "Binderlab",
  about: "en sida i Binderlab",
  chips: ["Hur gick förra veckan?", "Vad ska jag göra i dag?"],
  refillerChips: ["Vad behöver fyllas på i dag?"],
};

export function pageInfo(route: RouteId | null): PageInfo {
  return (route && PAGE_INFO[route]) || GENERIC;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9][a-z0-9-]{0,39}$/i;
const SHELL_KEYS = ["period", "from", "to"] as const;
/** Sökvägen hamnar i systemprompten: bara tecken som appens adresser använder. */
const SAFE_PATH = /^\/[A-Za-z0-9/_.-]{0,199}$/;

/**
 * Ett namn (butik, automat, titel) som en rad utan tecken som kan se ut som taggar eller
 * nya instruktionsrader. Namnen kommer ur kassasystemet och är data.
 */
export function safeName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f<>"`{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** Detaljsidan ur sökvägen och frågesträngen. */
function detailOf(path: string, search: URLSearchParams): PageContext["detail"] {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "automater" && parts[1] && CODE.test(parts[1]) && parts[1] !== "enhetsekonomi") {
    return { kind: "automat", ref: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === "butiker" && parts[1] && UUID.test(parts[1])) {
    return { kind: "butik", ref: parts[1].toLowerCase() };
  }
  const titel = search.get("titel");
  if (parts[0] === "inkopspriser" && titel && UUID.test(titel)) {
    return { kind: "titel", ref: titel.toLowerCase() };
  }
  return null;
}

/** Sammanhanget ur webbläsarens adress (klienten). */
export function pageContextFromUrl(pathname: string, search: string): PageContext {
  const sp = new URLSearchParams(search);
  const path = pathname.slice(0, 200) || "/";
  const shell: Record<string, string> = {};
  for (const k of SHELL_KEYS) {
    const v = sp.get(k);
    if (v && v.length <= 20) shell[k] = v;
  }
  const butik = sp.get("butik");
  const automat = sp.get("automat");
  return {
    route: activeRouteId(path),
    path,
    shell,
    storeId: butik && UUID.test(butik) ? butik.toLowerCase() : null,
    machineId: automat && UUID.test(automat) ? automat.toLowerCase() : null,
    vmb: sp.get("vmb") === "1",
    detail: detailOf(path, sp),
  };
}

/**
 * Sammanhanget som servern fick (JSON från webbläsaren), validerat. Rutten räknas fram ur
 * sökvägen igen; ogiltiga id:n blir null. null om det saknas eller inte är ett objekt.
 */
export function parsePageContext(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const path = str(r.path, 200);
  if (!path || !SAFE_PATH.test(path)) return null;
  const shellRaw = (r.shell && typeof r.shell === "object" ? r.shell : {}) as Record<
    string,
    unknown
  >;
  const shell: Record<string, string> = {};
  for (const k of SHELL_KEYS) {
    const v = str(shellRaw[k], 20);
    if (v) shell[k] = v;
  }
  const uuidOrNull = (v: unknown) => {
    const s = str(v, 36);
    return s && UUID.test(s) ? s.toLowerCase() : null;
  };
  let detail: PageContext["detail"] = null;
  if (r.detail && typeof r.detail === "object") {
    const d = r.detail as Record<string, unknown>;
    const ref = str(d.ref, 40);
    if (ref && d.kind === "automat" && CODE.test(ref)) detail = { kind: "automat", ref };
    if (ref && (d.kind === "butik" || d.kind === "titel") && UUID.test(ref)) {
      detail = { kind: d.kind, ref: ref.toLowerCase() };
    }
  }
  return {
    route: activeRouteId(path),
    path,
    shell,
    storeId: uuidOrNull(r.storeId),
    machineId: uuidOrNull(r.machineId),
    vmb: r.vmb === true,
    detail,
  };
}

/** Ser rollen ekonomi (belopp, priser, vinst)? */
function economyRole(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "viewer";
}

/** Rollen får använda assistenten (och ser knappen "Fråga AI"). */
export function canUseAssistant(role: Role): boolean {
  return routeById("assistent").roles.includes(role);
}

/**
 * Förslagen (chips) för sidan, 2–3 st. {namn} byts mot detaljsidans namn (butiken), eller
 * "butikerna" utan detalj. Påfyllare får bara lagerförslag.
 */
export function suggestionsFor(
  page: PageContext,
  role: Role,
  detailName?: string | null,
): string[] {
  const info = pageInfo(page.route);
  const chips = economyRole(role)
    ? info.chips
    : (info.refillerChips ?? GENERIC.refillerChips ?? []);
  const name = detailName?.trim();
  return chips
    .slice(0, 3)
    .map((c) =>
      c.includes("{namn}")
        ? name
          ? c.replace("{namn}", name)
          : c.replace("{namn}", "butikerna")
        : c,
    );
}

/** "Förklara vinst" från ett nyckeltal, som frågan i panelen. */
export function explainQuestion(metric: string): string {
  const m = metric.replace(/\s+/g, " ").trim().slice(0, 80);
  return m ? `Förklara ${m.charAt(0).toLowerCase()}${m.slice(1)}` : "Förklara siffran";
}

/** Verktyget som ger sidans sammanfattning, med standardparametrar (period och filter). */
export interface SummaryCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export function summaryCallFor(
  page: PageContext,
  role: Role,
  period: { start: string; end: string },
): SummaryCall | null {
  const range = { fran: period.start, till: period.end };
  const scope = {
    ...(page.storeId ? { butik: page.storeId } : {}),
    ...(page.machineId ? { automat: page.machineId } : {}),
  };
  if (!economyRole(role)) {
    if (page.route === "lager" || page.route === "att-gora") {
      return {
        tool: "rackvidd",
        input: { antal: 8, ...(page.machineId ? { automat: page.machineId } : {}) },
      };
    }
    if (page.route === "drift") return { tool: "besoksplan", input: {} };
    return null;
  }
  if (page.detail?.kind === "butik") {
    return { tool: "butiksandel", input: { butik: page.detail.ref } };
  }
  if (page.detail?.kind === "automat") {
    return { tool: "nyckeltal", input: { ...range, automat: page.detail.ref } };
  }
  switch (page.route) {
    case "hem":
    case "lonsamhet":
    case "order":
    case "automater":
    case "butiker":
    case "rapporter":
    case "ekonomi":
      return { tool: "nyckeltal", input: { ...range, ...scope } };
    case "inkopspriser":
      return { tool: "inkopspriser", input: { ...range, ...scope, antal: 8 } };
    case "lager":
    case "att-gora":
      return {
        tool: "rackvidd",
        input: { antal: 8, ...(page.machineId ? { automat: page.machineId } : {}) },
      };
    case "vart-lager":
      return { tool: "vart_lager", input: { antal: 10 } };
    case "prognos":
      return { tool: "inkopsforslag", input: {} };
    case "drift":
      return { tool: "automat_status", input: {} };
    case "avtal":
      return { tool: "avtal", input: {} };
    case "datakallor":
      return { tool: "synk", input: {} };
    default:
      return null;
  }
}

/**
 * Sidans sammanfattning som data före frågan (i användarens meddelande, inte i
 * systemprompten: texten bygger på namn ur kassasystemet och är aldrig instruktioner).
 */
export function pageSummaryNote(summary: string): string {
  const clean = summary.replace(/[<>]/g, "").slice(0, 2000);
  return `<sidan>\n${clean}\n</sidan>`;
}

/** Raderna om sidan i systemprompten. */
export function pagePromptText(args: {
  readonly page: PageContext;
  readonly periodText: string | null;
  readonly storeName: string | null;
  readonly machineName: string | null;
  readonly detailName: string | null;
  readonly summary: string | null;
}): string {
  const info = pageInfo(args.page.route);
  const filters = [
    args.storeName ? `butik ${safeName(args.storeName)}` : null,
    args.machineName ? `automat ${safeName(args.machineName)}` : null,
  ].filter(Boolean);
  const path = SAFE_PATH.test(args.page.path) ? args.page.path : "/";
  return [
    `Användaren tittar just nu på sidan ${info.name} (${path}), som visar ${info.about}.`,
    args.detailName ? `Sidan gäller ${safeName(args.detailName)}.` : "",
    args.periodText ? `Sidans period: ${args.periodText}.` : "",
    `Filter: ${filters.length ? filters.join(", ") : "inga (hela organisationen)"}. Med VMB: ${args.page.vmb ? "på" : "av"}.`,
    'Frågor som "den här", "siffran" eller "varför" gäller den sidan, perioden och filtret. Använd dem när frågan inte säger annat.',
    args.summary
      ? "Sidans sammanfattning står först i frågan, inom <sidan>, och är data ur verktyget."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
