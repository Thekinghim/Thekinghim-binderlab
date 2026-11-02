/**
 * Datamodell v2 som data. Driver diagrammet på /datamodell.
 * Källa i text: docs/datamodell.md.
 */

export type ColKind = "pk" | "fk" | "uk" | "col";
export type Col = { n: string; t: string; k?: ColKind; ref?: string };
export type Access = "refiller" | "finance" | "admin";
export type Table = {
  name: string;
  domain: DomainKey;
  cols: Col[];
  /** Synlig för påfyllare (tillåtlista) eller bara ägare/admin/läsare */
  access: Access;
  appendOnly?: boolean;
  view?: boolean;
  isNew?: boolean;
  later?: string;
  note?: string;
};

export type DomainKey =
  | "org"
  | "settings"
  | "places"
  | "titles"
  | "import"
  | "stock"
  | "purchasing"
  | "goals"
  | "reports"
  | "later";

export const domains: Record<DomainKey, { label: string; index: string }> = {
  org: { label: "Organisation och åtkomst", index: "01" },
  settings: { label: "Inställningar, perioder, logg", index: "02" },
  places: { label: "Platser och avtal", index: "03" },
  titles: { label: "Titlar och priser", index: "06" },
  import: { label: "Datakällor och order", index: "05" },
  stock: { label: "Lager", index: "07" },
  purchasing: { label: "Inköp", index: "08" },
  goals: { label: "Mål och utgångsläge", index: "04" },
  reports: { label: "Rapporter", index: "09" },
  later: { label: "Senare faser", index: "10" },
};

const id: Col = { n: "id", t: "uuid", k: "pk" };

export const tables: Table[] = [
  // 01 Organisation
  {
    name: "organizations",
    domain: "org",
    access: "refiller",
    cols: [
      id,
      { n: "slug", t: "text", k: "uk" },
      { n: "timezone", t: "text" },
      { n: "plan", t: "text" },
      { n: "machine_limit", t: "int" },
    ],
    note: "Alla tabeller har organization_id → organizations",
  },
  {
    name: "profiles",
    domain: "org",
    access: "refiller",
    cols: [
      { n: "user_id", t: "uuid", k: "pk" },
      { n: "display_name", t: "text" },
      { n: "anonymized_at", t: "timestamptz" },
    ],
  },
  {
    name: "memberships",
    domain: "org",
    access: "refiller",
    cols: [id, { n: "user_id", t: "uuid", k: "uk", ref: "profiles" }, { n: "role", t: "role" }],
    note: "Minst en ägare. Ingen rollhöjning förbi egen roll.",
  },
  {
    name: "invitations",
    domain: "org",
    access: "admin",
    cols: [
      id,
      { n: "email", t: "citext" },
      { n: "role", t: "role" },
      { n: "token_hash", t: "bytea" },
      { n: "expires_at", t: "timestamptz" },
      { n: "accepted_by", t: "uuid", k: "fk", ref: "profiles" },
    ],
  },

  // 02 Platser
  {
    name: "stores",
    domain: "places",
    access: "refiller",
    cols: [
      id,
      { n: "name", t: "text" },
      { n: "address", t: "text" },
      { n: "contact_email", t: "citext" },
      { n: "is_example", t: "bool" },
    ],
  },
  {
    name: "store_agreements",
    domain: "places",
    access: "finance",
    cols: [
      id,
      { n: "store_id", t: "uuid", k: "fk", ref: "stores" },
      { n: "valid_from", t: "date" },
      { n: "commission_bp", t: "int" },
      { n: "monthly_rent_ore", t: "bigint" },
    ],
    note: "Perioder överlappar inte",
  },
  {
    name: "machines",
    domain: "places",
    access: "refiller",
    cols: [
      id,
      { n: "code", t: "text", k: "uk" },
      { n: "name", t: "text" },
      { n: "active_from", t: "date" },
      { n: "active_to", t: "date" },
    ],
  },
  {
    name: "machine_placements",
    domain: "places",
    access: "refiller",
    isNew: true,
    cols: [
      id,
      { n: "machine_id", t: "uuid", k: "fk", ref: "machines" },
      { n: "store_id", t: "uuid", k: "fk", ref: "stores" },
      { n: "from", t: "date" },
      { n: "to", t: "date" },
    ],
  },
  {
    name: "machine_investments",
    domain: "places",
    access: "finance",
    cols: [
      id,
      { n: "machine_id", t: "uuid", k: "fk", ref: "machines" },
      { n: "amount_ore", t: "bigint" },
      { n: "depreciation_months", t: "int" },
    ],
  },

  // 03 Titlar
  {
    name: "titles",
    domain: "titles",
    access: "refiller",
    cols: [
      id,
      { n: "name", t: "text" },
      { n: "merged_into_id", t: "uuid", k: "fk", ref: "titles" },
    ],
  },
  {
    name: "title_aliases",
    domain: "titles",
    access: "refiller",
    cols: [
      id,
      { n: "title_id", t: "uuid", k: "fk", ref: "titles" },
      { n: "alias", t: "text" },
      { n: "alias_normalized", t: "text", k: "uk" },
    ],
  },
  {
    name: "purchase_prices",
    domain: "titles",
    access: "finance",
    cols: [
      id,
      { n: "title_id", t: "uuid", k: "fk", ref: "titles" },
      { n: "unit_cost_ore", t: "bigint" },
      { n: "valid_from", t: "date" },
    ],
  },

  // 04 Import
  {
    name: "data_sources",
    domain: "import",
    access: "finance",
    cols: [
      id,
      { n: "provider", t: "text" },
      { n: "source_timezone", t: "text" },
      { n: "secret_ref", t: "text" },
      { n: "cursor", t: "text" },
    ],
  },
  {
    name: "source_machines",
    domain: "import",
    access: "finance",
    isNew: true,
    cols: [
      id,
      { n: "data_source_id", t: "uuid", k: "fk", ref: "data_sources" },
      { n: "external_id", t: "text", k: "uk" },
      { n: "external_name", t: "text" },
      { n: "machine_id", t: "uuid", k: "fk", ref: "machines" },
    ],
  },
  {
    name: "imports",
    domain: "import",
    access: "finance",
    cols: [
      id,
      { n: "data_source_id", t: "uuid", k: "fk", ref: "data_sources" },
      { n: "file_sha256", t: "text" },
      { n: "parser_version", t: "text" },
      { n: "rows_new", t: "int" },
    ],
  },
  {
    name: "import_rows",
    domain: "import",
    access: "finance",
    appendOnly: true,
    cols: [
      id,
      { n: "import_id", t: "uuid", k: "fk", ref: "imports" },
      { n: "status", t: "text" },
      { n: "raw", t: "jsonb" },
      { n: "order_id", t: "uuid", k: "fk", ref: "orders" },
    ],
  },
  {
    name: "orders",
    domain: "import",
    access: "finance",
    cols: [
      id,
      { n: "external_id", t: "text", k: "uk" },
      { n: "data_source_id", t: "uuid", k: "fk", ref: "data_sources" },
      { n: "title_id", t: "uuid", k: "fk", ref: "titles" },
      { n: "machine_id", t: "uuid", k: "fk", ref: "machines" },
      { n: "import_id", t: "uuid", k: "fk", ref: "imports" },
      { n: "ordered_at", t: "timestamptz" },
      { n: "business_date", t: "date" },
      { n: "amount_ore", t: "bigint" },
      { n: "raw_title", t: "text" },
    ],
    note: "Unik (org, källa, ordernummer)",
  },

  // 05 Lager
  {
    name: "stock_locations",
    domain: "stock",
    access: "refiller",
    cols: [id, { n: "kind", t: "text" }, { n: "machine_id", t: "uuid", k: "fk", ref: "machines" }],
  },
  {
    name: "stock_events",
    domain: "stock",
    access: "refiller",
    appendOnly: true,
    cols: [
      id,
      { n: "location_id", t: "uuid", k: "fk", ref: "stock_locations" },
      { n: "title_id", t: "uuid", k: "fk", ref: "titles" },
      { n: "kind", t: "text" },
      { n: "quantity", t: "int" },
      { n: "order_id", t: "uuid", k: "fk", ref: "orders" },
      { n: "performed_by", t: "uuid", k: "fk", ref: "profiles" },
    ],
    note: "Försäljning skrivs hit som antal, utan belopp",
  },
  {
    name: "stock_levels",
    domain: "stock",
    access: "refiller",
    view: true,
    cols: [
      { n: "location_id", t: "uuid", ref: "stock_locations" },
      { n: "title_id", t: "uuid", ref: "titles" },
      { n: "on_hand", t: "int" },
    ],
  },

  // 06 Inköp
  {
    name: "suppliers",
    domain: "purchasing",
    access: "finance",
    cols: [id, { n: "name", t: "text" }, { n: "default_lead_time_days", t: "int" }],
  },
  {
    name: "supplier_items",
    domain: "purchasing",
    access: "finance",
    isNew: true,
    cols: [
      id,
      { n: "supplier_id", t: "uuid", k: "fk", ref: "suppliers" },
      { n: "title_id", t: "uuid", k: "fk", ref: "titles" },
      { n: "pack_size", t: "int" },
      { n: "min_order_qty", t: "int" },
    ],
  },
  {
    name: "purchase_orders",
    domain: "purchasing",
    access: "finance",
    cols: [
      id,
      { n: "supplier_id", t: "uuid", k: "fk", ref: "suppliers" },
      { n: "status", t: "text" },
      { n: "expected_on", t: "date" },
    ],
  },
  {
    name: "purchase_order_lines",
    domain: "purchasing",
    access: "finance",
    cols: [
      id,
      { n: "purchase_order_id", t: "uuid", k: "fk", ref: "purchase_orders" },
      { n: "title_id", t: "uuid", k: "fk", ref: "titles" },
      { n: "unit_cost_ore", t: "bigint" },
    ],
  },

  // 07 Mål
  {
    name: "goals",
    domain: "goals",
    access: "finance",
    cols: [
      id,
      { n: "scope", t: "text" },
      { n: "month", t: "date" },
      { n: "metric", t: "text" },
      { n: "target", t: "bigint" },
    ],
  },
  {
    name: "baselines",
    domain: "goals",
    access: "finance",
    cols: [id, { n: "scope", t: "text" }, { n: "metric", t: "text" }, { n: "value", t: "bigint" }],
  },

  // 09 Rapporter
  {
    name: "report_recipients",
    domain: "reports",
    access: "finance",
    cols: [
      id,
      { n: "kind", t: "text" },
      { n: "email", t: "citext" },
      { n: "store_id", t: "uuid", k: "fk", ref: "stores" },
    ],
  },
  {
    name: "reports",
    domain: "reports",
    access: "finance",
    cols: [
      id,
      { n: "kind", t: "text" },
      { n: "period_start", t: "date" },
      { n: "data_snapshot", t: "jsonb" },
      { n: "calc_version", t: "text" },
    ],
  },
  {
    name: "report_deliveries",
    domain: "reports",
    access: "finance",
    appendOnly: true,
    isNew: true,
    cols: [
      id,
      { n: "report_id", t: "uuid", k: "fk", ref: "reports" },
      { n: "recipient_id", t: "uuid", k: "fk", ref: "report_recipients" },
      { n: "sent_at", t: "timestamptz" },
    ],
  },

  // 10 Inställningar
  {
    name: "organization_settings",
    domain: "settings",
    access: "finance",
    cols: [
      { n: "organization_id", t: "uuid", k: "pk" },
      { n: "vat_rate_bp", t: "int" },
      { n: "card_fee_bp", t: "int" },
    ],
  },
  {
    name: "owner_shares",
    domain: "settings",
    access: "finance",
    cols: [
      id,
      { n: "member_user_id", t: "uuid", k: "fk", ref: "profiles" },
      { n: "share_bp", t: "int" },
      { n: "valid_from", t: "date" },
    ],
  },
  {
    name: "ledger_accounts",
    domain: "settings",
    access: "finance",
    cols: [id, { n: "key", t: "text", k: "uk" }, { n: "account_no", t: "text" }],
  },
  {
    name: "period_closes",
    domain: "settings",
    access: "finance",
    isNew: true,
    cols: [
      id,
      { n: "month", t: "date", k: "uk" },
      { n: "closed_by", t: "uuid", k: "fk", ref: "profiles" },
      { n: "snapshot", t: "jsonb" },
    ],
  },
  {
    name: "audit_log",
    domain: "settings",
    access: "finance",
    appendOnly: true,
    cols: [
      id,
      { n: "table_name", t: "text" },
      { n: "row_id", t: "uuid" },
      { n: "actor_id", t: "uuid", k: "fk", ref: "profiles" },
      { n: "before", t: "jsonb" },
      { n: "after", t: "jsonb" },
    ],
  },

  // 11 Senare
  {
    name: "alerts",
    domain: "later",
    access: "finance",
    later: "fas 8",
    cols: [
      id,
      { n: "kind", t: "text" },
      { n: "severity", t: "text" },
      { n: "machine_id", t: "uuid", k: "fk", ref: "machines" },
    ],
  },
  {
    name: "incidents",
    domain: "later",
    access: "finance",
    later: "fas 8",
    cols: [
      id,
      { n: "machine_id", t: "uuid", k: "fk", ref: "machines" },
      { n: "started_at", t: "timestamptz" },
    ],
  },
  {
    name: "contracts",
    domain: "later",
    access: "finance",
    later: "fas 9",
    cols: [id, { n: "store_id", t: "uuid", k: "fk", ref: "stores" }, { n: "valid_to", t: "date" }],
  },
];

/** Placering i diagrammet: kolumner med domäner uppifrån och ned. */
export const layout: DomainKey[][] = [
  ["org", "settings"],
  ["places", "goals"],
  ["import"],
  ["titles", "stock"],
  ["purchasing", "reports", "later"],
];
