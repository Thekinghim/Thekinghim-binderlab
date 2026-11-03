/**
 * Utvärderingen av assistenten: svenska frågor om seedens data (13 okt – 1 nov 2026,
 * "i dag" = måndag 2 nov 2026) med verktyget som ska användas och parametrarna som
 * måste stå i anropet.
 *
 * Används på två sätt:
 * - offline i test/db/assistent-eval.test.ts med den lokala testmodellen (verktygsval,
 *   kontrollen av talen och de förväntade talen ur seeden), och
 * - live med Claude API i scripts/assistant-eval.ts (opt-in, några frågor, kostar pengar).
 *
 * Ren data.
 */

import type { MemberRole } from "@/db/schema";

export interface EvalCase {
  readonly id: string;
  readonly question: string;
  /** Sidan frågan ställs från (sökväg och frågesträng), som i AI-panelen. */
  readonly page?: string;
  readonly role?: MemberRole;
  /** Verktyget som ska anropas (bland modellens anrop). */
  readonly tool: string;
  /** Parametrar som anropet måste ha (delmängd). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Svaret ska ha minst en knapp (foresla_knapp). */
  readonly button?: boolean;
}

export const EVAL_NOW = "2026-11-02T10:00:00Z";
const OCT = { fran: "2026-10-01", till: "2026-10-31" };

export const EVAL_CASES: readonly EvalCase[] = [
  { id: "oktober", question: "Hur gick oktober?", tool: "nyckeltal", input: OCT },
  {
    id: "basta-automat",
    question: "Vilken automat tjänade mest i oktober?",
    tool: "lonsamhet",
    input: { ...OCT, per: "automat" },
  },
  {
    id: "basta-butik",
    question: "Vilken butik tjänade mest i oktober?",
    tool: "lonsamhet",
    input: { ...OCT, per: "butik" },
  },
  {
    id: "mest-salda",
    question: "Vilka titlar sålde flest pack förra veckan?",
    tool: "salda_pack",
    input: { fran: "2026-10-26", till: "2026-11-01", per: "titel" },
  },
  {
    id: "varfor",
    question: "Varför gick vinsten ner i oktober?",
    tool: "forandring",
    input: OCT,
  },
  {
    id: "jamfor-veckor",
    question: "Hur gick förra veckan jämfört med veckan innan?",
    tool: "forandring",
    input: { fran: "2026-10-26", till: "2026-11-01" },
  },
  {
    id: "butiksandel",
    question: "Hur mycket får Spelbutiken Centrum (exempel) i månaden?",
    tool: "butiksandel",
    input: { butik: "Spelbutiken Centrum (exempel)" },
    button: true,
  },
  {
    id: "forlust",
    question: "Vilka titlar går med förlust?",
    page: "/inkopspriser?from=2026-10-01&to=2026-10-31",
    tool: "inkopspriser",
    input: { ...OCT, visa: "forlust" },
    button: true,
  },
  {
    id: "saknar-pris",
    question: "Vilka titlar saknar inköpspris i oktober?",
    tool: "inkopspriser",
    input: { ...OCT, visa: "saknar_pris" },
  },
  {
    id: "timme",
    question: "När på dygnet säljer vi mest i oktober?",
    tool: "tid_monster",
    input: { ...OCT, per: "timme" },
  },
  {
    id: "veckodag",
    question: "Vilken veckodag säljer vi mest i oktober?",
    tool: "tid_monster",
    input: { ...OCT, per: "veckodag" },
  },
  {
    id: "slutsalt",
    question: "Vad förlorade vi på slutsålt i oktober?",
    tool: "slutsalt",
    input: OCT,
  },
  { id: "vart-lager", question: "Hur länge räcker vårt lager?", tool: "vart_lager" },
  {
    id: "fyll-forst",
    question: "Vilken automat ska jag fylla på först?",
    page: "/automater",
    tool: "besoksplan",
    button: true,
  },
  { id: "tyst", question: "Är någon automat tyst?", tool: "automat_status" },
  { id: "avtal", question: "Vilka avtal går ut snart?", tool: "avtal" },
  { id: "bokforing", question: "Vilken månad är klar att bokföra?", tool: "bokforing" },
  { id: "synk", question: "Fungerar synken från Awish?", tool: "synk" },
  {
    id: "bestall",
    question: "Vad ska jag beställa inför nästa vecka?",
    tool: "inkopsforslag",
    button: true,
  },
  { id: "prognos", question: "Hur mycket säljer vi nästa vecka?", tool: "prognos" },
  { id: "kvar", question: "Hur många pack finns kvar i lagret?", tool: "lager" },
  { id: "viktigast", question: "Vad är viktigast i dag?", tool: "att_gora" },
  {
    id: "forklara-sidan",
    question: "Förklara vinsten",
    page: "/lonsamhet?from=2026-10-13&to=2026-11-01",
    tool: "nyckeltal",
    input: { fran: "2026-10-13", till: "2026-11-01" },
  },
  {
    id: "pafyllare",
    question: "Vad behöver fyllas på i dag?",
    page: "/lager",
    role: "refiller",
    tool: "rackvidd",
    button: true,
  },
];
