/**
 * Raden under "Underlag" på ett larm: hur många gånger problemet har setts och hur många
 * utskick som faktiskt har gått fram till någon. Förr stod "aviserat N gånger", som räknade
 * aviseringar även när ingen prenumererade och inget skickades. Ren funktion.
 */
export function seenText(a: {
  readonly occurrences: number;
  readonly lastSeen: string;
  /** Utskick som gått fram. null = den inloggade får inte se andras utskick. */
  readonly delivered: number | null;
}): string {
  const seen = `Sett ${a.occurrences} ${a.occurrences === 1 ? "gång" : "gånger"}, senast ${a.lastSeen}.`;
  if (a.delivered === null) return seen;
  if (a.delivered === 0) return `${seen} Inget utskick har gått fram till någon.`;
  return `${seen} ${a.delivered} utskick har gått fram.`;
}
