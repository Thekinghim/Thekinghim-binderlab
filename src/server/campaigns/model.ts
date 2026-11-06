/**
 * Kampanjer på automaternas skärm: rena regler (inga anrop, ingen databas), så att de
 * kan testas utan nätverk. Tjänsten (./service.ts) gör anropen till Awish.
 *
 * - En kampanj = text + bild + start och slut, på en eller flera automater. I Awish blir
 *   den en kampanjbild (Banner) per automat med bildens publika adress och utgångstiden.
 * - Start "nu" skickas direkt efter bekräftelsen. En senare start skickas av den
 *   schemalagda Awish-körningen (var femte minut) när starttiden har passerat.
 * - "Stäng av" sätter utgångstiden i Awish till nu (Awish har ingen radering).
 * - Förslag: en titel som kom in i en automat de senaste 14 dagarna (första
 *   sortimentsperioden) och som ingen kampanj har gällt sedan dess.
 */

import { z } from "zod";

import { addDays, isIsoDate, type IsoDate } from "@/domain";
import { zonedToUtc } from "@/import/zoned";

import type { AwishBanner } from "../awish/grpc-client";

export const CAMPAIGN_TITLE_MAX = 60;
/** Största bild (3 MB): under Vercels gräns för en förfrågan (4,5 MB) med formuläret. */
export const CAMPAIGN_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
/** Längsta kampanj (Awish visar den tills utgångstiden). */
export const CAMPAIGN_MAX_DAYS = 90;
/** Förslag gäller titlar som kom in så här många dagar bakåt. */
export const SUGGEST_DAYS = 14;
/** Högst så många förslag (resten är brus för den som ska välja). */
export const SUGGEST_MAX = 3;

export const CAMPAIGN_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;
export type CampaignImageType = keyof typeof CAMPAIGN_IMAGE_TYPES;

/** Bildens typ ur innehållet (magiska bytes), inte ur webbläsarens uppgift. */
export function sniffCampaignImage(bytes: Uint8Array): CampaignImageType | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

const noControl = /^[^\p{Cc}]*$/u;

export const campaignInputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Skriv en text.")
      .max(CAMPAIGN_TITLE_MAX, `Högst ${CAMPAIGN_TITLE_MAX} tecken.`)
      .regex(noControl, "Texten får inte ha radbrytningar."),
    /** Tomt = alla kopplade automater. */
    machineIds: z.array(z.string().uuid("Okänd automat.")).max(200),
    /** null = nu. */
    startsOn: z
      .string()
      .refine((v) => isIsoDate(v), "Ogiltigt startdatum.")
      .nullable(),
    endsOn: z.string().refine((v) => isIsoDate(v), "Välj slutdatum."),
    titleId: z.string().uuid().nullable(),
    /** En bild som redan använts (kampanjens id), i stället för en ny fil. */
    reuseImageFrom: z.string().uuid().nullable(),
  })
  .strict();
export type CampaignInput = z.infer<typeof campaignInputSchema>;

export class CampaignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignError";
  }
}

/** Dagens början i zonen (00:00 lokal tid) som UTC. */
function startOfDay(day: IsoDate, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return zonedToUtc({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timeZone).utc;
}

/**
 * Start och slut som tidpunkter: start = nu eller startdagens början, slut = slutdagens
 * slut (dagen efter 00:00). Kastar CampaignError för ett ogiltigt intervall.
 */
export function campaignWindow(
  input: Pick<CampaignInput, "startsOn" | "endsOn">,
  ctx: { now: Date; today: IsoDate; timeZone: string },
): { startsAt: Date; endsAt: Date; startsNow: boolean } {
  const startsNow = input.startsOn === null || input.startsOn <= ctx.today;
  const startsAt = startsNow ? ctx.now : startOfDay(input.startsOn as IsoDate, ctx.timeZone);
  const endsOn = input.endsOn as IsoDate;
  if (endsOn < ctx.today) throw new CampaignError("Slutdatumet har redan varit.");
  if (input.startsOn && endsOn < input.startsOn) {
    throw new CampaignError("Slutdatumet är före startdatumet.");
  }
  if (endsOn > addDays(ctx.today, CAMPAIGN_MAX_DAYS)) {
    throw new CampaignError(`Högst ${CAMPAIGN_MAX_DAYS} dagar.`);
  }
  const endsAt = startOfDay(addDays(endsOn, 1), ctx.timeZone);
  if (endsAt <= startsAt) throw new CampaignError("Kampanjen hinner inte börja.");
  return { startsAt, endsAt, startsNow };
}

/** Unix-sekunder (Awish expired_at). */
export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export type MachineRunStatus = "scheduled" | "sending" | "shown" | "failed" | "stopped";

/** Kampanjens läge för listan. */
export type CampaignState = "live" | "partial" | "scheduled" | "failed" | "ended" | "stopped";

export function campaignState(
  c: { startsAt: Date; endsAt: Date; stoppedAt: Date | null },
  machines: readonly { status: MachineRunStatus }[],
  now: Date,
): CampaignState {
  if (c.stoppedAt) return "stopped";
  if (c.endsAt <= now) return "ended";
  const shown = machines.filter((m) => m.status === "shown").length;
  const failed = machines.filter((m) => m.status === "failed").length;
  if (shown > 0 && failed > 0) return "partial";
  if (shown > 0) return "live";
  if (failed > 0 && machines.every((m) => m.status === "failed" || m.status === "stopped")) {
    return "failed";
  }
  return "scheduled";
}

export const CAMPAIGN_STATE_LABEL: Record<CampaignState, string> = {
  live: "Visas nu",
  partial: "Visas på några",
  scheduled: "Planerad",
  failed: "Kom inte fram",
  ended: "Slut",
  stopped: "Avstängd",
};

/**
 * Kampanjbilden som Awish skapade: den i listan efter som inte fanns före och har samma
 * bild och text (nyaste id om flera). null om den inte syns (Awish id saknas då).
 */
export function findCreatedBanner(
  before: readonly AwishBanner[],
  after: readonly AwishBanner[],
  wanted: { coverImage: string; title: string },
): AwishBanner | null {
  const known = new Set(before.map((b) => b.id));
  const hits = after.filter(
    (b) => !known.has(b.id) && b.coverImage === wanted.coverImage && b.title === wanted.title,
  );
  hits.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  return hits[0] ?? null;
}

/** Förslag: "Nytt: <titel>" på automaterna där titeln kom in nyligen. */
export interface CampaignSuggestion {
  readonly titleId: string;
  readonly titleName: string;
  readonly text: string;
  readonly machineIds: string[];
  /** Första dagen titeln fanns i någon av automaterna. */
  readonly since: IsoDate;
}

/**
 * Förslag på "Nytt: <titel>"-kampanjer, högst `SUGGEST_MAX`, nyast först. En titel är ny när
 * den kom till flottan de senaste `SUGGEST_DAYS` dagarna. "Kom till" = tidigaste av första
 * sortimentsdagen och första försäljningen: sortimentet registrerades först 2–3 nov. 2026
 * (Awish-synken), så en titel som sålt sedan 14 okt. är inte ny bara för att facket syns nu.
 * Automater där titeln gått ut (ingen gällande period) eller är slut föreslås inte.
 */
export function suggestCampaigns(input: {
  /** Första sortimentsdagen per automat och titel (machine_slots, min valid_from). */
  readonly firstStocked: readonly {
    titleId: string;
    titleName: string;
    machineId: string;
    firstOn: IsoDate;
    /** Första försäljningen av titeln i automaten, om någon. */
    firstSale?: IsoDate | null;
    /** Titeln har en gällande period i dag (inte utgången). Standard sant. */
    current?: boolean;
    /** Pack i automaten nu (null = okänt). 0 = slut: ingen kampanj för något som inte finns. */
    onHand?: number | null;
  }[];
  /** Titlar som en kampanj (inte avstängd före start) gällt, med kampanjens skapelsedag. */
  readonly campaigned: readonly { titleId: string; createdOn: IsoDate }[];
  /** Automater som kan få kampanjer (kopplade till Awish). */
  readonly linkedMachineIds: readonly string[];
  readonly today: IsoDate;
}): CampaignSuggestion[] {
  const from = addDays(input.today, -SUGGEST_DAYS);
  const linked = new Set(input.linkedMachineIds);
  const byTitle = new Map<
    string,
    { name: string; machines: Set<string>; since: IsoDate; everBefore: boolean }
  >();
  for (const r of input.firstStocked) {
    const firstOn = r.firstSale && r.firstSale < r.firstOn ? r.firstSale : r.firstOn;
    const g = byTitle.get(r.titleId) ?? {
      name: r.titleName,
      machines: new Set<string>(),
      since: firstOn,
      everBefore: false,
    };
    const showable = r.current !== false && r.onHand !== 0;
    if (firstOn < from) g.everBefore = true;
    else if (linked.has(r.machineId) && showable) {
      g.machines.add(r.machineId);
      if (firstOn < g.since || g.since < from) g.since = firstOn;
    }
    byTitle.set(r.titleId, g);
  }
  const out: CampaignSuggestion[] = [];
  for (const [titleId, g] of byTitle) {
    // Bara titlar som är nya i flottan (inte en titel som funnits länge i en annan automat).
    if (g.everBefore || g.machines.size === 0) continue;
    if (input.campaigned.some((c) => c.titleId === titleId && c.createdOn >= g.since)) continue;
    out.push({
      titleId,
      titleName: g.name,
      text: `Nytt: ${g.name}`.slice(0, CAMPAIGN_TITLE_MAX),
      machineIds: [...g.machines].sort(),
      since: g.since,
    });
  }
  return out
    .sort((a, b) =>
      a.since < b.since ? 1 : a.since > b.since ? -1 : a.titleName.localeCompare(b.titleName, "sv"),
    )
    .slice(0, SUGGEST_MAX);
}
