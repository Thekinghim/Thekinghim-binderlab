/**
 * Ersättare i dagens rutt (V2, byggplanen 3.2 punkt 4): när en titel inte räcker hemma blir
 * fack tomma vid besöket. Då föreslås en annan titel som vi har gott om hemma, så att facket
 * inte står tomt. Bara förslag: Fyll på fyller titeln som står i facket om inte påfyllaren
 * väljer ersättaren.
 *
 *   kvar hemma   = vårt lager − dagens packlista (det som redan ska med)
 *   fackets djup = kapacitet ÷ antal fack (när facken är kända), annars bristen
 *   ersättare    = titeln med mest kvar hemma, inte samma titel, inte mystery pack, och med
 *                  minst ett helt fack kvar hemma (lika: namnordning)
 *   antal        = bristen, högst det som finns kvar, i hela fack när djupet är känt
 *   fack         = antal ÷ djup (avrundat uppåt), annars 1
 *
 * Stoppen gås igenom i ruttordning, så att det första stoppet får välja först och samma pack
 * aldrig föreslås två gånger. Ren funktion.
 */

export interface SubstituteLine {
  readonly titleId: string;
  readonly titleName: string;
  /** Pack som saknas hemma för att fylla titeln (PackLine.shortBy). */
  readonly shortBy: number;
  readonly capacity: number | null;
  readonly channels: readonly string[];
}

export interface SubstituteStop {
  readonly machineId: string;
  readonly lines: readonly SubstituteLine[];
}

export interface Substitute {
  readonly machineId: string;
  /** Titeln som inte räcker. */
  readonly forTitleId: string;
  readonly forTitleName: string;
  readonly titleId: string;
  readonly titleName: string;
  readonly packs: number;
  /** Antal fack som får ersättaren. */
  readonly slots: number;
}

export function suggestSubstitutes(input: {
  /** Stoppen i ruttordning. */
  readonly stops: readonly SubstituteStop[];
  /** Vårt lager per titel (alla egna lager tillsammans). */
  readonly home: ReadonlyMap<string, number>;
  /** Dagens packlista per titel (det som redan ska med). */
  readonly load: ReadonlyMap<string, number>;
  readonly titleName: (titleId: string) => string;
  /** Titlar som aldrig föreslås (mystery packs, utgångna). */
  readonly exclude?: ReadonlySet<string>;
}): Substitute[] {
  const left = new Map<string, number>();
  for (const [titleId, onHand] of input.home) {
    const rest = Math.max(0, onHand) - (input.load.get(titleId) ?? 0);
    if (rest > 0 && !input.exclude?.has(titleId)) left.set(titleId, rest);
  }
  const out: Substitute[] = [];
  for (const stop of input.stops) {
    for (const line of stop.lines) {
      if (line.shortBy <= 0) continue;
      const depth =
        line.capacity !== null && line.capacity > 0 && line.channels.length > 0
          ? Math.max(1, Math.floor(line.capacity / line.channels.length))
          : null;
      const minimum = depth ?? 1;
      const pick = [...left.entries()]
        .filter(([id, n]) => id !== line.titleId && n >= minimum)
        .sort(
          (a, b) => b[1] - a[1] || input.titleName(a[0]).localeCompare(input.titleName(b[0]), "sv"),
        )[0];
      if (!pick) continue;
      const [titleId, available] = pick;
      let packs = Math.min(line.shortBy, available);
      if (depth !== null) {
        const whole = Math.ceil(line.shortBy / depth) * depth;
        packs = Math.min(whole, Math.floor(available / depth) * depth);
      }
      if (packs <= 0) continue;
      left.set(titleId, available - packs);
      out.push({
        machineId: stop.machineId,
        forTitleId: line.titleId,
        forTitleName: line.titleName,
        titleId,
        titleName: input.titleName(titleId),
        packs,
        slots: depth !== null ? Math.max(1, Math.ceil(packs / depth)) : 1,
      });
    }
  }
  return out;
}
