/**
 * "Varor i Awish": listan som visar det en chef behöver se per vara, räknat ur Binderlab.
 * Ren och klientsäker (inga nätverks- eller databasanrop); testas i goods-overview.test.ts.
 *
 * Awish visar bara id, kod och pris. Här kopplas varje vara till sin titel (samma alias som
 * importen använder), med försäljningen de senaste 30 dagarna, fack och pack i automaterna,
 * vårt lager, inköpspris och "Kvar per order" (samma ekonomi som Inköpspriser), och korta
 * flaggor för det som behöver åtgärdas.
 */

/**
 * Samma nyckel som goods.ts goodNameKey och title_aliases.alias_normalized (NFKC, gemener,
 * ett mellanslag). En egen kopia: goods.ts drar in node:crypto, och den här filen används
 * även i webbläsaren.
 */
function goodNameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Titeln en vara är kopplad till i Binderlab. */
export interface GoodTitleLink {
  readonly titleId: string;
  readonly titleName: string;
  readonly ownProduct: boolean;
  /** Dagens inköpspris (öre), eller null. */
  readonly purchasePriceOre: number | null;
}

/** En vara i Awish som listan behöver den. */
export interface OverviewGood {
  readonly id: number;
  readonly name: string;
  readonly priceOre: number | null;
  /** Bildens adress att visa (via Binderlabs bildväg), eller null utan bild. */
  readonly image: string | null;
}

/** Ett fack (ur Awishs Products) med automatens namn i Binderlab. */
export interface OverviewSlot {
  readonly goodId: number | null;
  readonly machine: string;
  readonly slot: string;
  readonly count: number;
  readonly capacity: number | null;
}

export type GoodFlagKind =
  "duplicate" | "unlinked" | "no-purchase" | "no-image" | "no-slot" | "low-margin" | "no-sales";

export interface GoodFlag {
  readonly kind: GoodFlagKind;
  readonly label: string;
}

export const GOOD_FLAG_LABEL: Record<GoodFlagKind, string> = {
  duplicate: "Samma namn två gånger i Awish",
  unlinked: "Inte kopplad till Binderlab",
  "no-purchase": "Saknar inköpspris",
  "no-image": "Ingen bild",
  "no-slot": "Ligger inte i något fack",
  "low-margin": "Låg marginal",
  "no-sales": "Sålt 0 st på 30 d",
};

/** En rad i listan (serialiserbar, skickas till klienten). */
export interface GoodRow {
  readonly id: number;
  readonly name: string;
  readonly priceOre: number | null;
  readonly image: string | null;
  readonly titleId: string | null;
  readonly titleName: string | null;
  readonly ownProduct: boolean;
  /** Sålda pack (order) de senaste 30 dagarna och vad kunderna betalade (öre, med moms). */
  readonly sold30: number;
  readonly revenue30Ore: number;
  readonly slots: readonly OverviewSlot[];
  /** Pack i varans fack just nu (summa). */
  readonly packsInSlots: number;
  /** Pack i våra lager (summan av de egna lagren), eller null utan titel. */
  readonly warehouse: number | null;
  readonly purchaseOre: number | null;
  /** Kvar per order före butikens andel (hela beloppet), som Inköpspriser. */
  readonly leftOre: number | null;
  /** Vår del per order (efter butikens andel). Bara när en butik eller automat är vald. */
  readonly shareLeftOre: number | null;
  readonly flags: readonly GoodFlag[];
}

export interface GoodsOverviewInput {
  readonly goods: readonly OverviewGood[];
  /** Titeln per varans id; saknas = inte kopplad. */
  readonly links: ReadonlyMap<number, GoodTitleLink>;
  /** Order och betalt belopp per titel, de senaste 30 dagarna. */
  readonly sales: ReadonlyMap<string, { readonly orders: number; readonly revenueOre: number }>;
  readonly slots: readonly OverviewSlot[];
  /** Pack i våra lager per titel. */
  readonly warehouse: ReadonlyMap<string, number>;
  /** Kvar per order per titel (före andelen, och vår del). */
  readonly economics: ReadonlyMap<
    string,
    { readonly leftBeforeOre: number | null; readonly leftOre: number | null }
  >;
  /** Visa vår del (butik eller automat vald). */
  readonly showShare: boolean;
  /**
   * Försäljningen gäller alla automater (ingen butik eller automat vald). Annars flaggas
   * inte "Sålt 0 st", eftersom facken gäller alla automater.
   */
  readonly allMachines: boolean;
}

/** Inköpet är minst 80 % av försäljningspriset. */
export function isLowMargin(purchaseOre: number | null, priceOre: number | null): boolean {
  if (purchaseOre === null || priceOre === null || priceOre <= 0) return false;
  return purchaseOre * 5 >= priceOre * 4;
}

const FLAG_ORDER: readonly GoodFlagKind[] = [
  "duplicate",
  "unlinked",
  "no-purchase",
  "no-image",
  "no-slot",
  "low-margin",
  "no-sales",
];

/** Raderna: de som behöver åtgärd först, sedan bäst säljande, sedan namn. */
export function buildGoodsOverview(input: GoodsOverviewInput): GoodRow[] {
  const nameCount = new Map<string, number>();
  for (const g of input.goods) {
    const k = goodNameKey(g.name);
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
  }
  const slotsByGood = new Map<number, OverviewSlot[]>();
  for (const s of input.slots) {
    if (s.goodId === null) continue;
    const list = slotsByGood.get(s.goodId);
    if (list) list.push(s);
    else slotsByGood.set(s.goodId, [s]);
  }

  const rows = input.goods.map((g): GoodRow => {
    const link = input.links.get(g.id) ?? null;
    const sales = link ? input.sales.get(link.titleId) : undefined;
    const slots = (slotsByGood.get(g.id) ?? [])
      .slice()
      .sort(
        (a, b) =>
          a.machine.localeCompare(b.machine, "sv", { numeric: true }) ||
          a.slot.localeCompare(b.slot, "sv", { numeric: true }),
      );
    const econ = link ? input.economics.get(link.titleId) : undefined;
    const purchaseOre = link?.purchasePriceOre ?? null;
    const sold30 = sales?.orders ?? 0;

    const kinds = new Set<GoodFlagKind>();
    if ((nameCount.get(goodNameKey(g.name)) ?? 0) > 1) kinds.add("duplicate");
    if (!link) kinds.add("unlinked");
    if (link && purchaseOre === null) kinds.add("no-purchase");
    if (!g.image) kinds.add("no-image");
    if (slots.length === 0) kinds.add("no-slot");
    if (isLowMargin(purchaseOre, g.priceOre)) kinds.add("low-margin");
    if (link && slots.length > 0 && input.allMachines && sold30 === 0) kinds.add("no-sales");

    return {
      id: g.id,
      name: g.name,
      priceOre: g.priceOre,
      image: g.image,
      titleId: link?.titleId ?? null,
      titleName: link?.titleName ?? null,
      ownProduct: link?.ownProduct ?? false,
      sold30,
      revenue30Ore: sales?.revenueOre ?? 0,
      slots,
      packsInSlots: slots.reduce((sum, s) => sum + Math.max(0, s.count), 0),
      warehouse: link ? (input.warehouse.get(link.titleId) ?? 0) : null,
      purchaseOre,
      leftOre: econ?.leftBeforeOre ?? null,
      shareLeftOre: input.showShare ? (econ?.leftOre ?? null) : null,
      flags: FLAG_ORDER.filter((k) => kinds.has(k)).map((kind) => ({
        kind,
        label: GOOD_FLAG_LABEL[kind],
      })),
    };
  });
  return sortGoodRows(rows);
}

export function sortGoodRows(rows: readonly GoodRow[]): GoodRow[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        Number(b.flags.length > 0) - Number(a.flags.length > 0) ||
        b.sold30 - a.sold30 ||
        a.name.localeCompare(b.name, "sv", { numeric: true }) ||
        a.id - b.id,
    );
}

export type GoodsFilter = "alla" | "atgard" | "i-automat" | "inte-i-automat";

export const GOODS_FILTERS: ReadonlyArray<{ value: GoodsFilter; label: string }> = [
  { value: "alla", label: "Alla" },
  { value: "atgard", label: "Behöver åtgärd" },
  { value: "i-automat", label: "I automat" },
  { value: "inte-i-automat", label: "Inte i automat" },
];

function matchesFilter(r: GoodRow, filter: GoodsFilter): boolean {
  switch (filter) {
    case "atgard":
      return r.flags.length > 0;
    case "i-automat":
      return r.slots.length > 0;
    case "inte-i-automat":
      return r.slots.length === 0;
    default:
      return true;
  }
}

/** Sökning (namn, titel eller id) och filter. Ordningen behålls. */
export function filterGoodRows(
  rows: readonly GoodRow[],
  filter: GoodsFilter,
  query: string,
): GoodRow[] {
  const q = goodNameKey(query);
  return rows.filter(
    (r) =>
      matchesFilter(r, filter) &&
      (q === "" ||
        goodNameKey(r.name).includes(q) ||
        (r.titleName !== null && goodNameKey(r.titleName).includes(q)) ||
        String(r.id) === q),
  );
}

/** Antal rader per filter (chipsens siffror). */
export function goodsFilterCounts(rows: readonly GoodRow[]): Record<GoodsFilter, number> {
  return {
    alla: rows.length,
    atgard: rows.filter((r) => matchesFilter(r, "atgard")).length,
    "i-automat": rows.filter((r) => matchesFilter(r, "i-automat")).length,
    "inte-i-automat": rows.filter((r) => matchesFilter(r, "inte-i-automat")).length,
  };
}

/**
 * Raden efter en sparad ändring (optimistiskt, och sedan med varan som lästes tillbaka):
 * namn, pris och bild byts; "Ingen bild", "Låg marginal" och "Samma namn" räknas om.
 */
export function withEditedGood(
  rows: readonly GoodRow[],
  goodId: number,
  next: { name: string; priceOre: number | null; image: string | null },
): GoodRow[] {
  const updated = rows.map((r) =>
    r.id === goodId ? { ...r, name: next.name, priceOre: next.priceOre, image: next.image } : r,
  );
  const nameCount = new Map<string, number>();
  for (const r of updated) {
    const k = goodNameKey(r.name);
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
  }
  return sortGoodRows(
    updated.map((r) => {
      const kinds = new Set(r.flags.map((f) => f.kind));
      const set = (kind: GoodFlagKind, on: boolean) => (on ? kinds.add(kind) : kinds.delete(kind));
      set("duplicate", (nameCount.get(goodNameKey(r.name)) ?? 0) > 1);
      set("no-image", !r.image);
      set("low-margin", isLowMargin(r.purchaseOre, r.priceOre));
      return {
        ...r,
        flags: FLAG_ORDER.filter((k) => kinds.has(k)).map((kind) => ({
          kind,
          label: GOOD_FLAG_LABEL[kind],
        })),
      };
    }),
  );
}
