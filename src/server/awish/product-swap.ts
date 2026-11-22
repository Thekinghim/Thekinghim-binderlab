/**
 * Produktbyte i ett Awish-fack (docs/design/v2/byggplan.md avsnitt 3.3). Ren funktion.
 *
 * När en vara byts direkt i Awish (titel A ut ur facket, titel B in) jämförs förra läsningens
 * fack per titel (machine_slot_capacity.channels) med Awishs fack nu. Ett fack som har bytt
 * titel är ett byte:
 *
 *   returned (A) = A:s saldo i automaten före läsningen − det Awish visar för A nu (minst 0).
 *                  A kan finnas kvar i andra fack: bara det som försvann går tillbaka.
 *                  Bara när A har ett räknat saldo på platsen (annars vet vi inte vad som fanns).
 *   taken (B)    = det Awish visar för B nu, när B inte har något räknat saldo i automaten
 *                  (B är ny i automaten: allt kom ur lagret). Har B ett räknat saldo drar den
 *                  vanliga påfyllningsregeln (refill-deduction.ts) ökningen, så här blir det 0
 *                  och inget dras två gånger.
 *
 * Flera bytta fack för samma titel: talet står på det första facket (kanalordning), de andra
 * får 0, så att summan aldrig räknas två gånger.
 *
 * Inget byte vid första läsningen (ingen förra läsning). Ett fack där A eller B väntar på en
 * sändning till Awish (`unsent`) skjuts upp (`deferred`): Awish visar ett gammalt läge för den
 * titeln. Bara de titlarna skjuts upp, inte hela automaten. Synken behåller då förra läsningens
 * fack så att bytet hittas när sändningen gått fram.
 *
 * Namnbyte direkt i Awish: B skapades just i den här läsningen (`newTitles`) och A finns inte
 * kvar i något fack. Det är samma vara under nytt namn, inte ett byte: inga pack flyttas
 * (`renamed`). Annars skulle allt av A gå "tillbaka" till lagret och allt av B tas ur ett lager
 * som aldrig haft B (fantompack).
 */

/** Ett fack i Awish nu, med titeln det kopplats till. */
export interface SwapChannelNow {
  readonly channel: string;
  readonly titleId: string;
}

export interface SwapLevel {
  /** Saldot på automatens plats före läsningen. */
  readonly quantity: number;
  /** Platsen har ett räknat saldo för titeln (last_counted_at satt). */
  readonly counted: boolean;
}

export interface DetectSwapsInput {
  /** Förra läsningens fack per titel (stock_locations.awish_channels, äldre: machine_slot_capacity). */
  readonly previous: ReadonlyMap<string, readonly string[]>;
  /** Facken nu (en rad per kanal med vara). */
  readonly current: readonly SwapChannelNow[];
  /** Pack per titel enligt Awish nu (alla fack). */
  readonly unitsNow: ReadonlyMap<string, number>;
  /** Saldot per titel på automatens plats före läsningen. */
  readonly levels: ReadonlyMap<string, SwapLevel>;
  /** Automaten har lästs från Awish förut (stock_locations.awish_synced_at). */
  readonly syncedBefore: boolean;
  /** Titlar som väntar på en sändning till Awish (unsentRefillTitles). */
  readonly unsent?: ReadonlySet<string>;
  /** Titlar som skapades i den här läsningen (okänt varunamn i Awish). */
  readonly newTitles?: ReadonlySet<string>;
}

export interface SwapClassification {
  readonly swaps: ProductSwap[];
  /** Fack som skjuts upp tills sändningen till Awish gått fram. */
  readonly deferred: string[];
  /** Fack där varan bara bytt namn i Awish (inget flyttas). */
  readonly renamed: { channel: string; fromTitleId: string; toTitleId: string }[];
}

export interface ProductSwap {
  readonly channel: string;
  readonly fromTitleId: string;
  readonly toTitleId: string;
  /** Pack av A som går tillbaka till lagret. */
  readonly returned: number;
  /** Pack av B som tas ur lagret. */
  readonly taken: number;
}

const byChannel = (a: string, b: string) =>
  a.localeCompare(b, "sv", { numeric: true, sensitivity: "base" });

/** Facken som bytt titel sedan förra läsningen, med pack tillbaka och pack tagna. */
export function detectSwaps(input: DetectSwapsInput): ProductSwap[] {
  return classifySwaps(input).swaps;
}

/** Byten, uppskjutna fack och namnbyten sedan förra läsningen. */
export function classifySwaps(input: DetectSwapsInput): SwapClassification {
  const none: SwapClassification = { swaps: [], deferred: [], renamed: [] };
  if (!input.syncedBefore || input.previous.size === 0) return none;
  const before = new Map<string, string>();
  for (const [titleId, channels] of input.previous) {
    for (const c of channels) {
      const key = c.trim();
      if (key) before.set(key, titleId);
    }
  }
  const changed = input.current
    .map((c) => ({ channel: c.channel.trim(), titleId: c.titleId }))
    .filter((c) => c.channel !== "")
    .filter((c) => {
      const was = before.get(c.channel);
      return was !== undefined && was !== c.titleId;
    })
    .sort((a, b) => byChannel(a.channel, b.channel));

  const out: ProductSwap[] = [];
  const deferred: string[] = [];
  const renamed: SwapClassification["renamed"] = [];
  const titlesNow = new Set(input.current.map((c) => c.titleId));
  const returnedFor = new Set<string>();
  const takenFor = new Set<string>();
  const seen = new Set<string>();
  for (const c of changed) {
    if (seen.has(c.channel)) continue;
    seen.add(c.channel);
    const from = before.get(c.channel)!;
    if (input.unsent?.has(from) || input.unsent?.has(c.titleId)) {
      deferred.push(c.channel);
      continue;
    }
    if (input.newTitles?.has(c.titleId) && !titlesNow.has(from)) {
      renamed.push({ channel: c.channel, fromTitleId: from, toTitleId: c.titleId });
      continue;
    }
    let returned = 0;
    if (!returnedFor.has(from)) {
      returnedFor.add(from);
      const level = input.levels.get(from);
      if (level?.counted) {
        returned = Math.max(0, Math.max(0, level.quantity) - (input.unitsNow.get(from) ?? 0));
      }
    }
    let taken = 0;
    if (!takenFor.has(c.titleId)) {
      takenFor.add(c.titleId);
      const level = input.levels.get(c.titleId);
      if (!level?.counted) taken = Math.max(0, input.unitsNow.get(c.titleId) ?? 0);
    }
    out.push({ channel: c.channel, fromTitleId: from, toTitleId: c.titleId, returned, taken });
  }
  return { swaps: out, deferred, renamed };
}

/** Noteringen på flytten: "Produktbyte A3: Black Bolt → Surging Sparks". */
export function swapNote(channel: string, fromName: string, toName: string): string {
  return `Produktbyte ${channel}: ${fromName} → ${toName}`.slice(0, 500);
}
