/**
 * Vad "Exportera all data" tar med: en CSV-fil per tabell med organisationens egna rader.
 * Kolumnerna läses ur databasen (alla kolumner användaren får läsa), utom de som står i
 * `omit`: tekniska fält och hänvisningar till hemligheter. Inga hemligheter finns i
 * tabellerna (de ligger i Vault), men datakällans config och secret_ref är interna.
 *
 * Ren data, testas i export.test.ts och test/db/granskning.test.ts.
 */

export interface ExportTable {
  /** Filnamnet i ZIP-filen. */
  readonly file: string;
  /** Tabellen i schemat public. */
  readonly table: string;
  /** Vad filen innehåller (står i LASMIG.txt). */
  readonly description: string;
  /** Kolumner som inte tas med. */
  readonly omit?: readonly string[];
  /** Sortering (kolumner). Standard: created_at, id. */
  readonly orderBy?: readonly string[];
}

export const EXPORT_TABLES: readonly ExportTable[] = [
  {
    file: "organisation.csv",
    table: "organizations",
    description: "Organisationen: namn, tidszon, valuta.",
    omit: ["plan", "machine_limit"],
  },
  {
    file: "installningar.csv",
    table: "organization_settings",
    description: "Kortavgift, moms (baspunkter), räkenskapsår och företagsuppgifter.",
  },
  { file: "butiker.csv", table: "stores", description: "Butikerna där automaterna står." },
  {
    file: "butiksavtal.csv",
    table: "store_agreements",
    description: "Butikens ersättning: provision (baspunkter) och hyra (öre) per period.",
  },
  {
    file: "kontrakt.csv",
    table: "contracts",
    description: "Kontrakt med butiker (villkor och datum; filerna laddas ner i appen).",
    omit: ["storage_path"],
  },
  { file: "automater.csv", table: "machines", description: "Automaterna." },
  {
    file: "placeringar.csv",
    table: "machine_placements",
    description: "Vilken butik varje automat stått i, och när.",
  },
  {
    file: "investeringar.csv",
    table: "machine_investments",
    description: "Investeringar per automat (öre).",
  },
  { file: "fack.csv", table: "machine_slots", description: "Fack per automat och titel." },
  { file: "titlar.csv", table: "titles", description: "Titlar (produkter)." },
  {
    file: "titelalias.csv",
    table: "title_aliases",
    description: "Namnen som automatplattformen skriver, kopplade till titlarna.",
  },
  {
    file: "inkopspriser.csv",
    table: "purchase_prices",
    description: "Inköpspris per titel (öre per pack) från ett datum.",
  },
  {
    file: "datakallor.csv",
    table: "data_sources",
    description: "Datakällorna (Awish, CSV). Inloggningar ligger i Vault och tas inte med.",
    omit: ["config", "secret_ref", "cursor"],
  },
  {
    file: "kallautomater.csv",
    table: "source_machines",
    description: "Automaterna som plattformen känner dem, och kopplingen till våra automater.",
  },
  {
    file: "importer.csv",
    table: "imports",
    description: "Alla importer och synkar med antal nya, dubbletter och fel.",
    omit: ["storage_path"],
  },
  {
    file: "order.csv",
    table: "orders",
    description: "All försäljning. amount_ore = belopp i öre inklusive moms. Tider i UTC.",
    orderBy: ["ordered_at", "id"],
  },
  {
    file: "lagerplatser.csv",
    table: "stock_locations",
    description: "Lagerplatser: automater och egna lager.",
  },
  {
    file: "lagerhandelser.csv",
    table: "stock_events",
    description: "Alla lagerhändelser: påfyllning, försäljning, inventering, svinn, flytt.",
    orderBy: ["seq"],
  },
  {
    file: "avrakningar.csv",
    table: "store_settlements",
    description: "Månadsavräkningar per butik (öre) och när de betalades.",
  },
  { file: "utbetalningar.csv", table: "payouts", description: "Utbetalningar från plattformen." },
  {
    file: "utbetalningsrader.csv",
    table: "payout_lines",
    description: "Orderna i varje utbetalning.",
  },
  { file: "fasta-kostnader.csv", table: "fixed_costs", description: "Fasta kostnader (öre)." },
  { file: "leverantorer.csv", table: "suppliers", description: "Leverantörer." },
  { file: "inkopsordrar.csv", table: "purchase_orders", description: "Inköpsordrar." },
  {
    file: "inkopsorderrader.csv",
    table: "purchase_order_lines",
    description: "Rader i inköpsordrarna (öre per pack).",
  },
  {
    file: "agarandelar.csv",
    table: "owner_shares",
    description: "Ägarandelar (baspunkter) från ett datum.",
  },
  {
    file: "stangda-manader.csv",
    table: "period_closes",
    description: "Stängda månader med sammanfattning.",
  },
];

/** Namnet på förklaringsfilen i ZIP-filen. */
export const README_FILE = "LASMIG.txt";
