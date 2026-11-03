/**
 * Lokal testmodell (ASSISTANT_PROVIDER=local, bara i development och tester). Ingen AI:
 * den väljer ett verktyg med enkla nyckelord, kör det mot riktig data via samma loop som
 * Claude API och svarar med verktygets egen sammanfattning. Svaret märks "Lokal
 * testmodell" i gränssnittet och i loggen (model = "lokal-testmodell").
 *
 * Syftet är att kunna prova hela kedjan (roller, verktyg, strömning, loggning, kontroll av
 * talen) utan nyckel till Claude API, inte att efterlikna en språkmodell.
 */

import "server-only";

import { addDays, monthEnd, type IsoDate } from "@/domain";
import { normalize } from "@/lib/fuzzy";

import { LOCAL_MODEL_NAME } from "./config";
import type { ModelClient, ModelTurnRequest } from "./model-client";
import {
  isQuestion,
  lastQuestion,
  lastToolResults,
  scriptedMessage,
  textBlock,
  toolUseBlock,
} from "./scripted";

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];

/** Gemener utan diakritik (även å, ä, ö), för nyckelorden nedan. */
function fold(text: string): string {
  return normalize(text).replace(/[åä]/g, "a").replace(/ö/g, "o");
}

/** "I dag är det måndag 2026-11-02" i systemprompten. */
function todayFrom(request: ModelTurnRequest): IsoDate {
  const text = request.system.map((b) => b.text).join("\n");
  return (
    /I dag är det \S+ (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? new Date().toISOString().slice(0, 10)
  );
}

/** Perioden i frågan: en månad, förra veckan, i år eller de senaste 30 dagarna. */
export function periodIn(question: string, today: IsoDate): { fran: IsoDate; till: IsoDate } {
  const q = fold(question);
  const month = MONTHS.findIndex((m) => q.includes(fold(m)));
  if (month >= 0) {
    const [y, m] = today.split("-").map(Number) as [number, number];
    const year = month + 1 > m ? y - 1 : y;
    const iso = `${year}-${String(month + 1).padStart(2, "0")}`;
    return { fran: `${iso}-01`, till: monthEnd(iso) };
  }
  if (q.includes("forra veckan")) {
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = måndag
    const monday = addDays(today, -dow - 7);
    return { fran: monday, till: addDays(monday, 6) };
  }
  if (q.includes("i ar")) return { fran: `${today.slice(0, 4)}-01-01`, till: today };
  if (q.includes("idag") || q.includes("i dag")) return { fran: today, till: today };
  return { fran: addDays(today, -29), till: today };
}

/** Sidans period i systemprompten ("… (2026-10-04 till 2026-11-02)"), eller null. */
export function pagePeriodFrom(system: string): { fran: IsoDate; till: IsoDate } | null {
  const m = /Sidans period: [^\n]*\((\d{4}-\d{2}-\d{2}) till (\d{4}-\d{2}-\d{2})\)/.exec(system);
  return m ? { fran: m[1]!, till: m[2]! } : null;
}

/** Sant om frågan anger en period (annars gäller sidans period, om den finns). */
function hasPeriod(question: string): boolean {
  const q = fold(question);
  return (
    MONTHS.some((m) => q.includes(fold(m))) ||
    /forra veckan|i ar\b|i dag|idag|senaste|vecka|manad/.test(q)
  );
}

/** Butiken i "får Sega gubben i månaden", som den står i frågan. */
function storeIn(question: string): string | undefined {
  const m = /f[åa]r\s+(.+?)\s+(?:i månaden|i manaden|per månad|per manad|varje månad)/i.exec(
    question,
  );
  const name = m?.[1]?.trim();
  return name && !/^butikerna?$/i.test(name) ? name : undefined;
}

/** Verktyget och parametrarna för frågan, bland dem som rollen har. */
export function chooseTool(
  question: string,
  today: IsoDate,
  available: ReadonlySet<string>,
  pagePeriod: { fran: IsoDate; till: IsoDate } | null = null,
): { name: string; input: Record<string, unknown> } | null {
  const q = fold(question);
  const period = pagePeriod && !hasPeriod(question) ? pagePeriod : periodIn(question, today);
  const has = (re: RegExp) => re.test(q);
  const per = has(/butik/) ? "butik" : has(/titel|titlar|serie/) ? "titel" : "automat";
  const store = storeIn(question);
  const candidates: Array<{ name: string; input: Record<string, unknown> } | false> = [
    has(/synk|awish/) && { name: "synk", input: {} },
    has(/bokfor|bokslut|sie|revisor/) && { name: "bokforing", input: {} },
    has(/avtal|uppsag|villkor/) && { name: "avtal", input: {} },
    has(/varfor|forandr|gick ner|minskade|okade|tappade|jamfort/) && {
      name: "forandring",
      input: { ...period, per: per === "automat" && !has(/automat/) ? "titel" : per },
    },
    (has(/far .* (i manaden|per manad)|butikens andel|butiksandel|ersattning/) ||
      has(/far butikerna/)) && {
      name: "butiksandel",
      input: store ? { butik: store } : {},
    },
    has(/slutsal|forlorad|tomma fack/) && { name: "slutsalt", input: period },
    has(/inkopspris|forlust|saknar pris|basta marginal|samsta marginal/) && {
      name: "inkopspriser",
      input: {
        ...period,
        ...(has(/forlust/) ? { visa: "forlust" } : has(/saknar/) ? { visa: "saknar_pris" } : {}),
      },
    },
    has(/timme|dygnet|klockan|pa kvallen|veckodag/) && {
      name: "tid_monster",
      input: { ...period, per: has(/veckodag/) ? "veckodag" : "timme" },
    },
    has(/vart lager|centrallager|hemma/) && { name: "vart_lager", input: {} },
    has(/besok|fylla pa forst|fyll pa forst|planera|packlista|ta med/) && {
      name: "besoksplan",
      input: {},
    },
    has(/tyst|trasig|fel pa|status|fungerar automat/) && { name: "automat_status", input: {} },
    has(/bestall|kopa in|inkop/) && { name: "inkopsforslag", input: {} },
    has(/bestall|fyll|pafyll|rackvidd|ta slut|tar slut/) && { name: "rackvidd", input: {} },
    has(/prognos|nasta vecka|framover|kommande/) && { name: "prognos", input: { vecka: 1 } },
    has(/att gora|uppgift|viktigast/) && { name: "att_gora", input: {} },
    has(/lager|kvar|saldo/) && { name: "lager", input: {} },
    has(/tjanade|vinst|lonsam|marginal|basta|samsta|mest|minst/) &&
      !has(/pack|forklara/) && { name: "lonsamhet", input: { ...period, per } },
    has(/salt|salde|pack|saljer/) && {
      name: "salda_pack",
      input: { ...period, per: per === "butik" ? "automat" : per },
    },
    has(/automater|butiker|vilka finns/) && { name: "hitta", input: {} },
    { name: "nyckeltal", input: period },
    { name: "rackvidd", input: {} },
  ];
  for (const c of candidates) {
    if (c && available.has(c.name)) return c;
  }
  return null;
}

/** Knappen som följer ett verktyg (foresla_knapp), eller null. */
export function followUpButton(
  tool: string,
  input: Record<string, unknown>,
): { typ: string; etikett: string; [k: string]: unknown } | null {
  switch (tool) {
    case "rackvidd":
    case "besoksplan":
      return { typ: "pafyllning", etikett: "Öppna påfyllning" };
    case "inkopsforslag":
      return { typ: "inkopslista", etikett: "Skapa inköpslista" };
    case "inkopspriser":
      return { typ: "sida", sida: "inkopspriser", etikett: "Gå till Inköpspriser" };
    case "butiksandel":
      return typeof input.butik === "string"
        ? { typ: "butik", butik: input.butik, etikett: `Öppna ${input.butik}` }
        : { typ: "sida", sida: "butiker", etikett: "Gå till Butiker" };
    case "forandring":
    case "lonsamhet":
      return { typ: "sida", sida: "lonsamhet", etikett: "Gå till Lönsamhet" };
    default:
      return null;
  }
}

/** Sammanfattningen ur ett verktygsresultat (JSON från loopen). */
function summaryOf(content: string, isError: boolean): string {
  try {
    const parsed = JSON.parse(content) as { sammanfattning?: unknown; fel?: unknown };
    if (isError) return `Verktyget kunde inte svara: ${String(parsed.fel ?? "okänt fel")}`;
    return String(parsed.sammanfattning ?? "");
  } catch {
    return "";
  }
}

/** Delar texten i bitar så att strömningen syns i gränssnittet. */
async function streamText(text: string, onText: (delta: string) => void, signal?: AbortSignal) {
  const parts = text.match(/\S+\s*/g) ?? [text];
  for (const part of parts) {
    if (signal?.aborted) break;
    onText(part);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
}

/** Verktygsanropen och resultaten för den senaste frågan (efter frågan i klartext). */
function callsSinceQuestion(
  messages: ModelTurnRequest["messages"],
): Array<{ name: string; input: Record<string, unknown>; content: string; isError: boolean }> {
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isQuestion(m)) {
      start = i + 1;
      break;
    }
  }
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const out: Array<{
    name: string;
    input: Record<string, unknown>;
    content: string;
    isError: boolean;
  }> = [];
  for (const m of messages.slice(start)) {
    if (!m.content || typeof m.content === "string") continue;
    if (m.role === "user" && isQuestion(m)) continue;
    for (const block of m.content) {
      if (block.type === "tool_use") {
        uses.set(block.id, {
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    if (m.role === "user") {
      for (const r of lastToolResults([m])) {
        const use = uses.get(r.toolUseId);
        if (use) out.push({ ...use, content: r.content, isError: r.isError });
      }
    }
  }
  return out;
}

export function createLocalModelClient(): ModelClient {
  return {
    provider: "local",
    model: LOCAL_MODEL_NAME,
    async turn(request, onText) {
      const calls = callsSinceQuestion(request.messages);
      if (calls.length > 0) {
        // Ett förslag på knapp efter första verktyget, om verktyget har ett nästa steg.
        const first = calls[0]!;
        const button = followUpButton(first.name, first.input);
        const asked = calls.some((c) => c.name === "foresla_knapp");
        if (
          button &&
          !asked &&
          !first.isError &&
          request.tools.some((t) => t.name === "foresla_knapp")
        ) {
          return scriptedMessage(LOCAL_MODEL_NAME, [
            toolUseBlock("foresla_knapp", { knappar: [button] }),
          ]);
        }
        const lines = calls
          .filter((c) => c.name !== "foresla_knapp")
          .map((c) => summaryOf(c.content, c.isError))
          .filter(Boolean);
        const answer = lines.join("\n");
        await streamText(answer, onText, request.signal);
        return scriptedMessage(LOCAL_MODEL_NAME, [textBlock(answer)]);
      }
      const question = lastQuestion(request.messages);
      const system = request.system.map((b) => b.text).join("\n");
      const choice = chooseTool(
        question,
        todayFrom(request),
        new Set(request.tools.map((t) => t.name)),
        pagePeriodFrom(system),
      );
      if (!choice) {
        const answer = "Den lokala testmodellen hittar inget verktyg för frågan.";
        await streamText(answer, onText, request.signal);
        return scriptedMessage(LOCAL_MODEL_NAME, [textBlock(answer)]);
      }
      return scriptedMessage(LOCAL_MODEL_NAME, [toolUseBlock(choice.name, choice.input)]);
    },
  };
}
