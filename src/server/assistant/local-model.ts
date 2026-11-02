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

/** Verktyget och parametrarna för frågan, bland dem som rollen har. */
export function chooseTool(
  question: string,
  today: IsoDate,
  available: ReadonlySet<string>,
): { name: string; input: Record<string, unknown> } | null {
  const q = fold(question);
  const period = periodIn(question, today);
  const has = (re: RegExp) => re.test(q);
  const per = has(/butik/) ? "butik" : has(/titel|titlar|serie/) ? "titel" : "automat";
  const candidates: Array<{ name: string; input: Record<string, unknown> } | false> = [
    has(/bestall|kopa in|inkop/) && { name: "inkopsforslag", input: {} },
    has(/bestall|fyll|pafyll|rackvidd|ta slut|tar slut/) && { name: "rackvidd", input: {} },
    has(/prognos|nasta vecka|framover|kommande/) && { name: "prognos", input: { vecka: 1 } },
    has(/att gora|uppgift/) && { name: "att_gora", input: {} },
    has(/lager|kvar|saldo/) && { name: "lager", input: {} },
    has(/tjanade|vinst|lonsam|marginal|basta|samsta|mest|minst/) &&
      !has(/pack/) && { name: "lonsamhet", input: { ...period, per } },
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

export function createLocalModelClient(): ModelClient {
  return {
    provider: "local",
    model: LOCAL_MODEL_NAME,
    async turn(request, onText) {
      const results = lastToolResults(request.messages);
      if (results.length > 0) {
        const lines = results.map((r) => summaryOf(r.content, r.isError)).filter(Boolean);
        const answer = lines.join("\n");
        await streamText(answer, onText, request.signal);
        return scriptedMessage(LOCAL_MODEL_NAME, [textBlock(answer)]);
      }
      const question = lastQuestion(request.messages);
      const choice = chooseTool(
        question,
        todayFrom(request),
        new Set(request.tools.map((t) => t.name)),
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
