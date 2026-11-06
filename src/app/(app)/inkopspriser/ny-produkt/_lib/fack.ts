/**
 * Varor i Awish: flikarna och förvalet i "Lägg i fack". Rena funktioner (testas utan Awish).
 */

export type GoodsTab = "redigera" | "fack" | "ny";

/** ?flik=fack eller ?flik=ny; allt annat är "Redigera vara". */
export function goodsTab(flik: string | null): GoodsTab {
  return flik === "fack" || flik === "ny" ? flik : "redigera";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Förvalet ur adressen: ?vara=<id i Awish> och ?titel=<uuid>. Ogiltiga värden blir null. */
export function goodsPreselect(
  vara: string | null,
  titel: string | null,
): { titleId: string | null; goodId: number | null } {
  const n = vara !== null && /^[0-9]{1,15}$/.test(vara) ? Number(vara) : NaN;
  return {
    titleId: titel && UUID.test(titel) ? titel.toLowerCase() : null,
    goodId: Number.isSafeInteger(n) && n > 0 ? n : null,
  };
}

/** Automaten som är vald från början: den enda kopplade, annars den valda i Inköpspriser. */
export function initialSlotMachine(
  machines: ReadonlyArray<{ id: string }>,
  scopeMachineId: string | null,
): string {
  if (machines.length === 1) return machines[0]!.id;
  return machines.find((m) => m.id === scopeMachineId)?.id ?? "";
}

/**
 * Varan som väljs när varorna i Awish har lästs. ?vara= gäller bara om varan finns i Awish
 * (annars ignoreras den, med en lugn rad); annars titelns vara om exakt en hör till titeln.
 */
export function pickPreselectedGood(
  want: { goodId: number | null; titleId: string | null },
  goods: ReadonlyArray<{ id: number }>,
  title: { titleName: string | null; goodId: number | null } | null,
): { goodId: string; notice: string | null } {
  if (want.goodId !== null) {
    return goods.some((g) => g.id === want.goodId)
      ? { goodId: String(want.goodId), notice: null }
      : { goodId: "", notice: "Varan finns inte i Awish längre. Välj vara i listan." };
  }
  if (want.titleId === null || !title) return { goodId: "", notice: null };
  if (title.goodId !== null && goods.some((g) => g.id === title.goodId)) {
    return { goodId: String(title.goodId), notice: null };
  }
  return {
    goodId: "",
    notice: title.titleName
      ? `Ingen vara i Awish hör till ${title.titleName}. Välj vara i listan.`
      : null,
  };
}
